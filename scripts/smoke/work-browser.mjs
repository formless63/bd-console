// Functional browser workflows on the harness's throwaway repo and scheduler.
import { writeFileSync } from 'node:fs';
import { launchChrome, resolveChrome } from './browser.mjs';
export async function runWorkBrowser(ctx) {
  const { assert, p, port } = ctx;
  const chrome = resolveChrome();
  if (chrome.skip) { console.log(`smoke skip (work-browser: ${chrome.skip})`); return; }
  const handle = await launchChrome(chrome.path);
  ctx.onCleanup(() => handle.close());
  const page = handle.page;
  const base = `http://127.0.0.1:${port}`;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const created = await post(p('/quick'), { title: 'Browser workflow fixture', priority: 1 });
  const id = created.id;
  const read = async () => (await fetch(p('/issues')).then(r => r.json())).issues.find(i => i.id === id);
  const wait = async (expression, label, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await page.evaluate(expression);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`work-browser: timed out waiting for ${label}; visible: ${(await page.evaluate('document.body.innerText'))?.slice(-1800)}`);
  };
  const clickText = async (text, selector = 'button') => {
    await wait(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`, text);
  };
  const fill = (selector, value) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await page.setViewport(1280, 900);
  await page.goto(base + '/#/');
  await wait(`document.querySelector('.work-center')?.innerText.includes('Browser workflow fixture')`, 'attention issue');
  assert(await page.evaluate(`!document.querySelector('.hub-capacity').open && !document.querySelector('.hub-capacity .quota-row')`), 'capacity must start collapsed');
  if (process.env.BD_CONSOLE_SCREENSHOT_DIR) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.BD_CONSOLE_SCREENSHOT_DIR + '/work-hub.png', Buffer.from(shot.data, 'base64'));
  }
  await fill('.work-filters input', 'Browser workflow');
  await wait(`document.querySelector('.work-results .work-row')?.textContent.includes('Browser workflow fixture')`, 'global search');
  await page.evaluate(`document.querySelector('.work-results .work-row').click()`);
  await wait(`document.querySelector('.c2-detail.open')?.innerText.includes('Browser workflow fixture')`, 'issue deep link');
  assert(await page.evaluate(`location.hash.endsWith('/issue/${id}')`), 'search must link directly to the correct issue');
  await clickText('Edit title & content');
  await fill('[data-issue-editor="content"] [name="title"]', 'Browser edited title');
  await fill('[data-issue-editor="content"] [name="description"]', 'Browser narrative');
  await page.evaluate(`document.querySelector('[data-issue-editor="content"]').requestSubmit()`);
  await wait(`!document.querySelector('[data-issue-editor="content"]') && document.querySelector('.c2-detail')?.innerText.includes('Browser edited title')`, 'saved editor');
  assert((await read()).description === 'Browser narrative', 'browser content edit must persist through Beads');
  await clickText('Edit title & content');
  await fill('[data-issue-editor="content"] [name="notes"]', 'Draft should survive');
  await page.evaluate(`(() => { window.confirm = () => false; document.querySelector('.c2-detail-close').click(); })()`);
  assert(await page.evaluate(`document.querySelector('[data-issue-editor="content"] [name="notes"]')?.value === 'Draft should survive'`), 'cancelled discard must keep draft');
  const current = await read();
  await post(p('/edit'), { id, op: 'set-content', fields: { notes: 'Changed elsewhere' }, expected: { notes: current.notes || '' } });
  await page.evaluate(`document.querySelector('[data-issue-editor="content"]').requestSubmit()`);
  await wait(`document.querySelector('[data-issue-editor="content"] [role="alert"]')?.textContent.includes('changed since')`, 'stale conflict');
  assert(await page.evaluate(`document.querySelector('[data-issue-editor="content"] [name="notes"]').value === 'Draft should survive'`), 'conflict must preserve draft');
  await page.evaluate(`window.confirm = () => true`);
  await clickText('Discard draft & reload');
  await wait(`!document.querySelector('[data-issue-editor="content"]')`, 'discard');
  await clickText('Record review evidence');
  await fill('[data-issue-editor="review"] [name="tests"]', 'Browser fixture validation');
  await fill('[data-issue-editor="review"] [name="decision"]', 'pending');
  await page.evaluate(`document.querySelector('[data-issue-editor="review"]').requestSubmit()`);
  await wait(`!document.querySelector('[data-issue-editor="review"]') && document.querySelector('.evidence-list')?.textContent.includes('Browser fixture validation')`, 'review evidence');
  await page.evaluate(`document.querySelector('.c2-detail-close').click()`);
  for (const width of [1280, 390]) {
    await page.setViewport(width, 844);
    await page.evaluate(`document.querySelector('.c2-tools').open = true`);
    await wait(`(() => { const el = document.querySelector('[data-mol-open]'); const r = el?.getBoundingClientRect(); if (!r) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === hit || el.contains(hit); })()`, 'Tools menu hit testing');
    assert(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Tools menu must fit viewport');
    await page.evaluate(`document.querySelector('.c2-tools').open = false`);
  }
  await page.evaluate(`location.hash = '#/'`);
  await wait(`document.querySelector('.work-center')?.innerText.includes('Needs review')`, 'review in attention');
  await page.evaluate(`([...document.querySelectorAll('.work-tabs button')].find(b => b.textContent.startsWith('Since review'))).click()`);
  await wait(`document.querySelector('.work-results')?.innerText.includes('Browser edited title')`, 'since-review activity');
  await clickText('Mark all loaded projects reviewed');
  await wait(`document.querySelector('.work-empty')?.textContent.includes('No changes')`, 'mark reviewed');
  await page.evaluate(`location.hash = '#/schedule'`);
  await wait(`document.querySelector('.sched-notifications')`, 'scheduler');
  await page.evaluate(`(() => { window.__notifications = []; window.Notification = class { static permission = 'granted'; static async requestPermission() { return 'granted'; } constructor(title, options) { window.__notifications.push({ title, ...options }); } close() {} }; })()`);
  await clickText('Enable failure alerts');
  await wait(`document.querySelector('.sched-notifications button')?.textContent.includes('Disable')`, 'notification opt-in');
  const job = await post(base + '/api/schedule', { prompt: 'PRIVATE_BROWSER_FIXTURE', session: `missing-browser-${Date.now()}`, runAt: Date.now() });
  assert(job.ok, 'test failure job must be created');
  await wait(`window.__notifications.some(n => n.body.includes('Prompt #${job.job.id} '))`, 'opt-in failure alert', 25000);
  assert(await page.evaluate(`!JSON.stringify(window.__notifications).includes('PRIVATE_BROWSER_FIXTURE')`), 'OS alert must not expose prompt');
  await wait(`document.querySelector('.sched-list')?.textContent.includes('PRIVATE_BROWSER_FIXTURE')`, 'failed job row');
  await page.evaluate(`(() => { const row = [...document.querySelectorAll('.sched-row')].find(el => el.textContent.includes('PRIVATE_BROWSER_FIXTURE')); row.querySelector('details').open = true; })()`);
  await wait(`document.querySelector('.sched-attempt')?.textContent.includes('failed')`, 'delivery history');
  await clickText('Disable failure alerts');
  await page.setViewport(390, 844);
  assert(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'scheduler receipts must fit a phone');
  console.log('smoke ok (work-browser: search/deep links, content save, draft guard/conflict, review, activity, private opt-in alerts, receipts)');
}
