// smoke: real-browser layout, stacking, scroll and hit-testing invariants.
//
//     node scripts/smoke.mjs browser
//
// OPT-IN — this domain is NOT part of `npm run smoke`.
// -----------------------------------------------------------------------------
// Every other domain runs in plain Node in milliseconds. This one boots Chrome,
// loads the app five times at two viewports, and costs ~10-20s. Charging that to
// the default run would make the fast feedback loop everyone actually uses
// slower for a class of bug that is real but rare, so the default domain list
// skips it (see the `optIn` flag in scripts/smoke.mjs) and `--list` marks it.
// Run it explicitly before touching layout, `position`, `overflow`, `z-index`,
// or the Detail slide-over.
//
// WHY IT EXISTS
// -----------------------------------------------------------------------------
// The suite is Node-only by design, which makes it structurally blind to the
// three frontend bug classes that actually recur here:
//
//   (a) CSS grid tracks with content-based minimums quietly widening past the
//       viewport (a `1fr` track whose content has an intrinsic min-width does
//       not shrink — the shell just gets wider than the screen)
//   (b) sibling stacking contexts painting over each other
//   (c) touch targets that render in the right place but do not receive taps
//
// bd-console-clb is the named regression below and the reason this file exists.
// `.c2` was `overflow: hidden`, which visually clips the parked Detail panel but
// still makes `.c2` a scroll container — one with no scrollbar. Focusing a
// control inside the panel mid-transition (while it was still translated off to
// the right) made the browser scroll that container ~100px to reveal it, and
// with no scrollbar there was no way back: the whole app was stranded
// off-viewport. Nothing in Node can see that. Only a real layout engine can.
//
// HOW WE DRIVE CHROME, AND WHY
// -----------------------------------------------------------------------------
// Directly over the Chrome DevTools Protocol, using Node's built-in WebSocket
// client and nothing else. No puppeteer, no puppeteer-core, no npm install.
//
// The alternative — `import('puppeteer-core')` when it happens to resolve — was
// rejected on purpose. This repo's zero-dependency, no-install-step property is
// load-bearing, and a test that silently depends on whatever a developer
// installed globally is a dependency with none of the honesty of a declared
// one: it resolves on the author's machine, resolves differently in CI, and
// does not resolve at all from a repo with no node_modules (which is every
// checkout of this one). The slice of CDP we need is small — navigate, evaluate,
// resize, click, press a key — so we implement that slice and stay truthful
// about having no dependencies.
//
// Chrome itself is still an external binary; it is resolved at run time (env
// override first, then the usual install locations, then a puppeteer-managed
// download if one happens to be on the machine) and its absence is a clean skip,
// exactly like the first-run test skips when port 4180 is busy.
//
// SCOPE
// -----------------------------------------------------------------------------
// Layout, stacking, scroll and hit-testing ONLY. No business logic: issue
// derivations, link semantics, the scheduler and the usage adapters are all
// tested faster and more reliably in Node by the other domains, and re-asserting
// them through a browser would only add flake. If an assertion here would still
// pass with the CSS deleted, it belongs in another domain.
//
// FLAKINESS
// -----------------------------------------------------------------------------
// No bare sleeps standing in for a condition. Everything waits on a predicate
// that must ALSO be stable across two consecutive samples (layout settled,
// transition finished), with a deadline and a failure message that names what
// never appeared plus the last value actually observed.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome resolution -------------------------------------------------------
// Order: explicit override, then PATH, then well-known install locations, then
// any Chrome a puppeteer install has downloaded into its cache. The hardcoded
// puppeteer cache path is a last resort and a glob, never the only option.

const PATH_NAMES = [
  'google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome',
];

const WELL_KNOWN = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// ~/.cache/puppeteer/chrome/<build>/chrome-linux64/chrome (and the mac layout).
function puppeteerCacheChromes(env) {
  const roots = [
    env.PUPPETEER_CACHE_DIR && join(env.PUPPETEER_CACHE_DIR, 'chrome'),
    join(env.HOME || homedir(), '.cache', 'puppeteer', 'chrome'),
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let builds;
    try { builds = readdirSync(root); } catch { continue; }
    for (const build of builds.sort().reverse()) {
      for (const rel of [
        ['chrome-linux64', 'chrome'],
        ['chrome-linux', 'chrome'],
        ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
        ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ]) {
        const p = join(root, build, ...rel);
        if (existsSync(p)) found.push(p);
      }
    }
  }
  return found;
}

// PATH is walked directly rather than shelling out to `which`/`command -v`:
// no shell, no quoting, and it behaves the same on a machine that has neither.
function onPath(names, env) {
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  const out = [];
  for (const name of names) {
    for (const dir of dirs) {
      const p = join(dir, name);
      if (existsSync(p)) { out.push(p); break; }
    }
  }
  return out;
}

// Returns { path, source } on success or { skip: '<reason>' }.
//
// Everything it consults comes from `env` (PATH, HOME, PUPPETEER_CACHE_DIR,
// BD_CONSOLE_CHROME) so the "this machine has no Chrome at all" branch can be
// exercised by passing a synthetic env, rather than by mangling the real one.
// An override that points at nothing is reported AS SUCH rather than silently
// falling through to some other Chrome — otherwise pointing BD_CONSOLE_CHROME
// at a bad path would not actually simulate absence.
export function resolveChrome(env = process.env) {
  const override = env.BD_CONSOLE_CHROME;
  if (override) {
    if (existsSync(override)) return { path: override, source: 'BD_CONSOLE_CHROME' };
    return { skip: `BD_CONSOLE_CHROME=${override} does not exist` };
  }
  for (const [source, list] of [
    ['PATH', onPath(PATH_NAMES, env)],
    ['well-known install path', WELL_KNOWN.filter((p) => existsSync(p))],
    ['puppeteer cache', puppeteerCacheChromes(env)],
  ]) {
    if (list.length) return { path: list[0], source };
  }
  return { skip: 'no Chrome/Chromium found on PATH, in the usual install locations, or in a puppeteer cache — set BD_CONSOLE_CHROME=/path/to/chrome to run this domain' };
}

// --- minimal CDP client ------------------------------------------------------
// Node 22+ ships a WHATWG WebSocket client on the global, which is the whole
// reason driving Chrome directly is viable without a dependency.

function openBrowserSocket(wsUrl, timeoutMs = 15000) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error(`CDP: websocket to ${wsUrl} never opened within ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveP(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP: websocket to ${wsUrl} errored`)); }, { once: true });
  });
}

function createClient(ws) {
  let nextId = 0;
  const pending = new Map();
  let closed = null;
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id == null) return; // an event; we poll instead of subscribing
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`CDP ${slot.method}: ${msg.error.message}`));
    else slot.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    closed = new Error('CDP: Chrome closed the connection');
    for (const slot of pending.values()) slot.reject(closed);
    pending.clear();
  });

  return {
    ws,
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(closed);
      const id = ++nextId;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((resolveP, reject) => {
        pending.set(id, { resolve: resolveP, reject, method });
        ws.send(JSON.stringify(payload));
      });
    },
  };
}

export async function launchChrome(chromePath) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'bd-console-smoke-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    // Sandboxing is off because the suite frequently runs in containers where
    // user namespaces are unavailable. The page is our own localhost fixture.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-search-engine-choice-screen',
    // NOT --hide-scrollbars: scrollbars occupy layout space, and hiding them
    // would mask exactly the overflow this domain exists to catch.
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const wsUrl = await new Promise((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error(`chrome: never printed a DevTools websocket URL within 20s\n${stderr.slice(-1500)}`)), 20000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); resolveP(m[0]); }
    });
    child.once('error', (err) => { clearTimeout(timer); reject(new Error(`chrome: failed to spawn ${chromePath}: ${err.message}`)); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`chrome: exited (${code}) before announcing DevTools\n${stderr.slice(-1500)}`)); });
  });

  const client = createClient(await openBrowserSocket(wsUrl));
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  const page = createPage(client, sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // Headless windows are not "focused" by the platform's definition, which
  // breaks :focus-visible and keyboard traversal. This makes the page behave as
  // if it were the foreground window.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  return {
    page,
    async close() {
      try { client.ws.close(); } catch { /* already gone */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      // Give it a beat to release the profile dir, then reap regardless.
      for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(50);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function createPage(client, sessionId) {
  const send = (method, params) => client.send(method, params, sessionId);

  // Every evaluation is wrapped so a transient DOM state (a node that has not
  // mounted yet) returns null instead of throwing and aborting the whole run.
  async function evaluate(expression) {
    let res;
    try {
      res = await send('Runtime.evaluate', {
        expression: `(() => { try { return (${expression}); } catch (e) { return { __evalError: String(e && e.message || e) }; } })()`,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (err) {
      // A document swap between the poll and its evaluation destroys the
      // execution context. That is a "not yet", not a failure — return null and
      // let the caller's deadline decide. Anything else is a real error.
      if (/context|detached|Session.*not found/i.test(err.message)) return null;
      throw err;
    }
    if (res.exceptionDetails) throw new Error(`page eval threw: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    const value = res.result?.value;
    if (value && typeof value === 'object' && value.__evalError) return null;
    return value;
  }

  return {
    send,
    evaluate,

    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
        screenWidth: width, screenHeight: height,
      });
    },

    // A full document load every time (via about:blank), so a hash-only change
    // can never leave the previous route's DOM in place and fool an assertion.
    async goto(url) {
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
    },

    // Real mouse input, not el.click(). A synthetic click bypasses hit-testing
    // and does not move focus, so it would skip both the stacking-context bug
    // class and the focus-restore path that bd-console-clb lived on.
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },

    async press(key) {
      const codes = { Escape: 27, Tab: 9 };
      const common = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    },

    // IME-style text insertion into whatever currently has focus — used for
    // the comment-composer draft below. Simpler and faster than a per-
    // character key-event sequence, and just as real from the page's point
    // of view (it lands through the same input pipeline a real IME would).
    async type(text) {
      await send('Input.insertText', { text });
    },
  };
}

// --- waiting -----------------------------------------------------------------
// `expression` must evaluate to an object carrying `ok`. We resolve only when
// `ok` is true AND the whole object is byte-identical to the previous sample,
// so a measurement taken mid-transition can never be mistaken for a settled
// one. On timeout the failure names the thing that never happened and prints
// the last state we actually saw, which is what makes a red run debuggable.
async function waitStable(page, expression, message, { timeout = 20000, interval = 80 } = {}) {
  const deadline = Date.now() + timeout;
  let prevJson = null;
  let last = null;
  while (Date.now() < deadline) {
    const value = await page.evaluate(expression);
    last = value;
    const json = JSON.stringify(value);
    if (value && value.ok && json === prevJson) return value;
    prevJson = json;
    await sleep(interval);
  }
  throw new Error(`browser: timed out waiting for ${message} — last state: ${JSON.stringify(last)}`);
}

// --- page-level probes (shared expression fragments) --------------------------

const SHELL_PROBE = `(() => {
  const c2 = document.querySelector('.c2');
  const detail = document.querySelector('.c2-detail');
  const header = document.querySelector('.c2-header');
  const body = document.querySelector('.c2-body');
  return {
    hasShell: !!c2,
    open: !!detail && detail.classList.contains('open'),
    inert: !!body && body.inert === true,
    // BOTH axes. .c2 uses \`overflow: clip\`, which clips without creating a
    // scroll container at all, so neither offset can ever become non-zero.
    // Downgrading that to \`overflow: hidden\` restores the scroll container and
    // the shell starts drifting — horizontally when focus chases the parked
    // panel, vertically when anything calls scrollIntoView.
    scrollLeft: c2 ? Math.round(c2.scrollLeft) : null,
    scrollTop: c2 ? Math.round(c2.scrollTop) : null,
    phantom: c2 ? c2.scrollWidth - c2.clientWidth : null,
    headerLeft: header ? Math.round(header.getBoundingClientRect().left) : null,
    panelLeft: detail ? Math.round(detail.getBoundingClientRect().left) : null,
    focusInside: !!(document.activeElement && document.activeElement.closest('.c2-detail')),
    activeTag: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
    innerWidth: window.innerWidth,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

const openProbe = `(() => { const s = ${SHELL_PROBE}; s.ok = s.open && s.focusInside && s.panelLeft !== null && s.panelLeft < s.innerWidth; return s; })()`;
const closedProbe = `(() => { const s = ${SHELL_PROBE}; s.ok = s.hasShell && !s.open && !s.inert && !s.focusInside; return s; })()`;
// Resolves the point we will actually click, and refuses to hand it back until
// elementFromPoint agrees that point belongs to the card. `inline: 'nearest'`
// on the scroll: bringing a card into view vertically is fine, scrolling the
// shell sideways to do it is the bug we are hunting.
const cardsProbe = `(() => {
  const cards = [...document.querySelectorAll('.c2-card-open')];
  const card = cards[0];
  if (!card) return { ok: false, count: cards.length, why: 'no .c2-card-open rendered' };
  card.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = card.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return {
    ok: r.width > 0 && r.height > 0 && y > 0 && y < window.innerHeight
        && !!hit && !!hit.closest('.c2-card-open'),
    count: cards.length, x, y,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    hit: hit ? (hit.className || hit.tagName) : null,
  };
})()`;

// --- the domain --------------------------------------------------------------

export async function runBrowser(ctx) {
  const { assert } = ctx;

  const chrome = resolveChrome();
  if (chrome.skip) {
    console.log(`smoke skip (browser: ${chrome.skip})`);
    return;
  }
  if (typeof WebSocket !== 'function') {
    console.log('smoke skip (browser: this Node build has no global WebSocket — needs Node >= 22)');
    return;
  }
  console.log(`smoke browser: driving ${chrome.path} over CDP (found via ${chrome.source})`);

  const base = `http://127.0.0.1:${ctx.port}`;
  // The scratch server's one registered project — the same throwaway git+beads
  // repo harness.mjs builds, already carrying the seed issue plus whatever the
  // baseline created. No new fixture.
  const projectHash = `#/p2/${encodeURIComponent(ctx.projectId)}`;

  const chromeHandle = await launchChrome(chrome.path);
  ctx.onCleanup(() => chromeHandle.close());
  const page = chromeHandle.page;

  // Open the Detail slide-over the way a user does: a real click on the centre
  // of the first card. Returns the settled open-state probe.
  async function openFirstCard() {
    const cards = await waitStable(page, cardsProbe,
      `an issue card (.c2-card-open) at ${projectHash} to render in view and be hit-testable`);
    await page.clickAt(cards.x, cards.y);
    return waitStable(page, openProbe, 'the Detail panel to open, take focus, and finish sliding into view');
  }

  async function gotoProject() {
    await page.goto(`${base}/${projectHash}`);
  }

  // --- modal + layout contract, desktop -------------------------------------
  await page.setViewport(1280, 900);
  await gotoProject();
  {
    const open = await openFirstCard();
    assert(open.open, 'browser: Detail panel did not open on a real click');
    assert(open.focusInside, 'browser: focus did not move inside the Detail panel (modal a11y contract)');
    assert(open.inert, 'browser: background (.c2-body) is not inert while the Detail panel is open');
    assert(open.scrollLeft === 0 && open.scrollTop === 0,
      `browser: opening the Detail panel scrolled the shell (.c2 scrollLeft=${open.scrollLeft}, scrollTop=${open.scrollTop}) — .c2 must not be a scroll container at all — bd-console-clb`);
    assert(open.panelLeft < open.innerWidth, `browser: Detail panel is off-screen when open (left=${open.panelLeft}, viewport=${open.innerWidth})`);
    assert(open.docOverflow <= 0, `browser: opening the Detail panel overflowed the document by ${open.docOverflow}px`);

    await page.press('Escape');
    const closed = await waitStable(page, closedProbe, 'the Detail panel to close on Escape and release focus');
    assert(!closed.open, 'browser: Escape did not close the Detail panel');
    assert(!closed.inert, 'browser: background inert was not released when the Detail panel closed');
    assert(closed.scrollLeft === 0 && closed.scrollTop === 0,
      `browser: shell left scrolled after Escape (.c2 scrollLeft=${closed.scrollLeft}, scrollTop=${closed.scrollTop}) — bd-console-clb`);
  }

  // --- focus trap, and the fact that traversing it never scrolls the shell ---
  {
    await openFirstCard();
    for (let i = 0; i < 12; i++) await page.press('Tab');
    const trapped = await waitStable(page, openProbe, 'focus to settle inside the Detail panel after 12 Tab presses');
    assert(trapped.focusInside, `browser: focus escaped the Detail panel after 12 Tabs (active=${trapped.activeTag})`);
    assert(trapped.scrollLeft === 0 && trapped.scrollTop === 0,
      `browser: tabbing through the Detail panel scrolled the shell (.c2 scrollLeft=${trapped.scrollLeft}, scrollTop=${trapped.scrollTop}) — bd-console-clb`);
    await page.press('Escape');
    await waitStable(page, closedProbe, 'the Detail panel to close after the focus-trap check');
  }

  // --- NAMED REGRESSION: bd-console-clb --------------------------------------
  // Every close path, because the scroll was inflicted by focus restoration on
  // teardown and each path tears down from a different place. `.c2` has no
  // scrollbar, so any non-zero scroll offset here means the app is stranded
  // with no way back — the failure mode that made this file exist.
  {
    const closers = [
      ['the X button', async () => {
        // Hit-tested, not just measured: a 28px control that has drifted out of
        // the viewport or under something else must fail HERE, naming itself,
        // rather than as a mystery timeout on the close that never happened.
        const btn = await waitStable(page, `(() => {
          const b = document.querySelector('.c2-detail-close');
          if (!b) return { ok: false, why: 'no .c2-detail-close' };
          const r = b.getBoundingClientRect();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          return { ok: r.width > 0 && !!hit && hit.closest('.c2-detail-close') === b, x, y,
                   rect: { x: Math.round(r.x), y: Math.round(r.y) }, hit: hit ? (hit.className || hit.tagName) : null };
        })()`, 'the Detail close (X) button to be on screen and receive a click at its own centre');
        await page.clickAt(btn.x, btn.y);
      }],
      ['the scrim', async () => {
        // Also a stacking-context assertion: the scrim must be the topmost
        // thing at that point, or the click lands on the list behind it.
        const scrim = await waitStable(page, `(() => {
          const s = document.querySelector('.c2-scrim');
          if (!s) return { ok: false, why: 'no .c2-scrim' };
          const r = s.getBoundingClientRect();
          const x = Math.round(r.x + 60), y = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          return { ok: !!hit && hit.classList.contains('c2-scrim'), x, y, hit: hit ? (hit.className || hit.tagName) : null };
        })()`, 'the scrim to be the topmost element at its own click point (stacking order)');
        await page.clickAt(scrim.x, scrim.y);
      }],
      ['Escape', async () => { await page.press('Escape'); }],
    ];

    for (const [label, close] of closers) {
      await gotoProject();
      await openFirstCard();
      await close();
      const after = await waitStable(page, closedProbe, `the Detail panel to close via ${label}`);
      assert(after.scrollLeft === 0 && after.scrollTop === 0,
        `bd-console-clb regression: closing the Detail panel via ${label} left the shell scrolled (.c2 scrollLeft=${after.scrollLeft}, scrollTop=${after.scrollTop}, phantom width=${after.phantom}px, active=${after.activeTag}) — .c2 has no scrollbar, so the app is stranded with no way back`);
      assert(after.headerLeft === 0,
        `bd-console-clb regression: closing the Detail panel via ${label} pushed .c2-header off the left edge (left=${after.headerLeft}px)`);
    }
  }

  // --- every route renders without widening past the viewport ----------------
  // Bug class (a): a grid track with a content-based minimum does not shrink,
  // so a long path/session name/commit subject silently makes the shell wider
  // than the screen. Checked at desktop and phone widths.
  {
    const routes = [
      ['#/', '.hub-card', 'a hub project card'],
      [projectHash, '.c2-card-open', 'an issue card'],
      ['#/tmux', '.strip-view', 'the tmux strip view'],
      ['#/schedule', '.strip-view, .sched-layout', 'the schedule view'],
      ['#/settings', '.settings-card', 'a settings card'],
    ];
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      await page.setViewport(width, height);
      for (const [hash, selector, human] of routes) {
        await page.goto(`${base}/${hash}`);
        const probe = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const text = (document.body.innerText || '').length;
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          const err = !!document.querySelector('.boot-error, .c2-booterr');
          return { ok: !!el && text > 40 && !err && location.hash === ${JSON.stringify(hash)}, overflow, text, err, hash: location.hash };
        })()`;
        const res = await waitStable(page, probe, `${human} at ${hash} @${width}px`);
        assert(!res.err, `browser: ${hash} @${width}px rendered a boot error`);
        assert(res.overflow <= 0,
          `browser: ${hash} @${width}px overflows the viewport horizontally by ${res.overflow}px — a track with a content-based minimum is refusing to shrink`);
      }
    }
  }

  // --- mobile: the panel is on screen AND actually receives taps -------------
  // Bug class (c): rendering in the right place is not the same as being
  // hittable. elementFromPoint is the only honest check.
  {
    await page.setViewport(390, 844);
    await gotoProject();
    await openFirstCard();
    const mobile = await waitStable(page, `(() => {
      const d = document.querySelector('.c2-detail');
      const c2 = document.querySelector('.c2');
      if (!d || !c2) return { ok: false, why: 'no shell' };
      const r = d.getBoundingClientRect();
      const x = Math.min(200, window.innerWidth - 5), y = 300;
      const hit = document.elementFromPoint(x, y);
      return {
        ok: d.classList.contains('open') && r.width > 0,
        left: Math.round(r.left), width: Math.round(r.width),
        scrollLeft: Math.round(c2.scrollLeft), scrollTop: Math.round(c2.scrollTop),
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        hitsPanel: !!(hit && hit.closest('.c2-detail')),
        hit: hit ? (hit.className || hit.tagName) : null,
      };
    })()`, 'the mobile Detail panel to settle');
    assert(mobile.left < 390, `browser (mobile): Detail panel is off-screen (left=${mobile.left}, width=${mobile.width})`);
    assert(mobile.scrollLeft === 0 && mobile.scrollTop === 0,
      `browser (mobile): opening the Detail panel shifted the shell (.c2 scrollLeft=${mobile.scrollLeft}, scrollTop=${mobile.scrollTop}) — bd-console-clb`);
    assert(mobile.docOverflow <= 0, `browser (mobile): document overflows horizontally by ${mobile.docOverflow}px with the Detail panel open`);
    assert(mobile.hitsPanel, `browser (mobile): a tap at (200,300) lands on "${mobile.hit}" instead of the open Detail panel — the panel renders but does not receive touches`);
    await page.press('Escape');
    await waitStable(page, closedProbe, 'the mobile Detail panel to close');
  }

  // --- live refresh must never clobber in-progress state (bd-console-974.4) --
  // A background data refresh (SSE change event, the poll fallback, or any
  // write) replaces store.issues.value wholesale with fresh objects carrying
  // the same ids — that's exactly what loadIssues() does. Simulated here via
  // window.__BD_CONSOLE_TEST_HOOKS__ (app.js) rather than a real server round
  // trip, because Node structurally can't observe the thing actually at risk:
  // whether the Detail panel and an in-progress comment draft survive a
  // Preact re-render triggered by that swap, which is exactly this domain's
  // reason to exist.
  {
    await gotoProject();
    await openFirstCard();

    // Comments live under the Activity tab, hidden by default (Detail opens
    // on Overview) — hit-tested like every other click above.
    const tab = await waitStable(page, `(() => {
      const b = document.querySelector('#c2-detail-tab-activity');
      if (!b) return { ok: false, why: 'no Activity tab' };
      const r = b.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { ok: r.width > 0 && !!hit && hit.closest('#c2-detail-tab-activity') === b, x, y };
    })()`, 'the Detail panel\'s Activity tab to render and be hit-testable');
    await page.clickAt(tab.x, tab.y);

    const ta = await waitStable(page, `(() => {
      const t = document.querySelector('.c2-comment-add textarea');
      if (!t) return { ok: false, why: 'no comment composer textarea' };
      const r = t.getBoundingClientRect();
      return { ok: r.width > 0 && r.height > 0, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`, 'the comment composer textarea to render');
    await page.clickAt(ta.x, ta.y);
    const draft = 'smoke draft ' + Date.now();
    await page.type(draft);

    const typed = await waitStable(page, `(() => {
      const t = document.querySelector('.c2-comment-add textarea');
      return { ok: !!t && t.value.length > 0, value: t ? t.value : null };
    })()`, 'the typed comment draft to land in the textarea');
    assert(typed.value === draft, `browser: comment draft mismatch before the simulated refresh (expected "${draft}", got "${typed.value}")`);

    const dispatched = await page.evaluate(`(() => {
      const hooks = window.__BD_CONSOLE_TEST_HOOKS__;
      if (!hooks) return { ok: false, why: 'no __BD_CONSOLE_TEST_HOOKS__ — app.js hook missing' };
      const s = hooks.store;
      s.issues.value = s.issues.value.map((i) => ({ ...i })); // fresh objects, same ids — what loadIssues() does
      s.generatedAt.value = Date.now();
      return { ok: true };
    })()`);
    assert(dispatched && dispatched.ok, `browser: could not dispatch a simulated live refresh (${dispatched && dispatched.why})`);

    const after = await waitStable(page, `(() => {
      const t = document.querySelector('.c2-comment-add textarea');
      const d = document.querySelector('.c2-detail');
      return {
        ok: !!t && !!d,
        value: t ? t.value : null,
        open: !!d && d.classList.contains('open'),
        focusInside: !!(document.activeElement && document.activeElement.closest('.c2-detail')),
      };
    })()`, 'the panel to settle after a simulated background refresh');
    assert(after.open, 'browser: a background data refresh closed the Detail panel — live refresh must never unmount it (bd-console-974.4)');
    assert(after.value === draft, `browser: a background data refresh lost the in-progress comment draft (expected "${draft}", got "${after.value}") — bd-console-974.4`);

    await page.press('Escape');
    await waitStable(page, closedProbe, 'the Detail panel to close after the live-refresh state-preservation check');
  }

  await chromeHandle.close();
  console.log('smoke browser ok: modal contract, bd-console-clb close paths, route overflow @1280+390, mobile hit-testing, live-refresh state preservation');
}
