// smoke: settings (HTTP + CLI), including the Termix linkage.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs settings
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// Termix deep-link composition (bd-console-4w7). Every export exercised below
// is pure string/shape work — no fetch, no Termix instance, no credential.
// fetchTermixHosts() is the module's one outbound function and is DELIBERATELY
// not called anywhere in this file: the whole point of splitting composition
// from transport is that the part users depend on can be proven offline.
import {
  termixAttachUrl, termixHomeUrl, termixLinkFor, decorateSessionsWithTermix,
  termixHostsUrl, normalizeTermixHosts, describeTermixFailure, looksLikeTermixApiKey,
} from '../../lib/termix.mjs';
import { validateTermixHostId } from '../../lib/config.mjs';

export async function runSettings(ctx) {
  const { assert, tempRoot, configDir, serverEntry, port, projectId, fixtures } = ctx;

  // --- Termix deep links (bd-console-4w7) -----------------------------------
  // FIXTURES ONLY. Nothing here touches a Termix install — no fetch is made,
  // no base URL is resolved, no credential exists. That is the point: the
  // thing a user clicks is pure derivation, so it can be pinned here rather
  // than only observed by having a Termix to click into.
  {
    const cfg = { baseUrl: 'https://termix.example.com', hostId: 7, token: 'tmx_' + 'a'.repeat(64) };

    // The deep-link contract, read from Termix's own src/main.tsx:
    // ?view=terminal&hostId=<id>&tmuxSession=<name>. Pinned as an exact
    // string because it is an UNDOCUMENTED internal contract — if a Termix
    // release changes it, this assertion is where we find out.
    assert(
      termixAttachUrl(cfg, 'work') === 'https://termix.example.com/?view=terminal&hostId=7&tmuxSession=work',
      `attach URL shape drifted: ${termixAttachUrl(cfg, 'work')}`
    );

    // A base URL with a path prefix (Termix behind a reverse-proxy subpath)
    // must keep the prefix and gain exactly one separator.
    assert(
      termixAttachUrl({ ...cfg, baseUrl: 'https://box.lan/termix' }, 'work')
        === 'https://box.lan/termix/?view=terminal&hostId=7&tmuxSession=work',
      'a subpath base URL must be preserved with a single separator'
    );

    // Session names are URL-ENCODED, never interpolated raw: tmux allows
    // ':' and '@' in a name, and both are reserved in a query string.
    const encoded = termixAttachUrl(cfg, 'ops:2@box');
    assert(encoded.endsWith('tmuxSession=ops%3A2%40box'), `session name must be percent-encoded: ${encoded}`);
    assert(new URLSearchParams(new URL(encoded).search).get('tmuxSession') === 'ops:2@box',
      'the encoded session name must decode back to the original');

    // Validation, not sanitization: anything SESSION_NAME_RE would reject at
    // the tmux exec boundary is refused here too, so a hostile-ish name can
    // never reach a composed URL at all.
    for (const bad of ['bad name', 'a/b', '../evil', 'x"y', '', null, undefined, 'a&view=shared']) {
      assert(termixAttachUrl(cfg, bad) === null, `a rejected session name must yield no URL: ${JSON.stringify(bad)}`);
      assert(termixLinkFor(cfg, bad) === null, `a rejected session name must yield no link: ${JSON.stringify(bad)}`);
    }

    // Degradation, and the honesty rule it encodes. No baseUrl -> no link at
    // all (nothing to offer). baseUrl but no hostId -> the link opens Termix
    // and SAYS it can't attach, rather than composing a ?view=terminal aimed
    // at no host, which would gate the user into an empty terminal.
    assert(termixLinkFor({}, 'work') === null, 'no base URL must render no link');
    assert(termixLinkFor({ baseUrl: null, hostId: 7 }, 'work') === null, 'a host id without a base URL is not a link');

    const partial = termixLinkFor({ baseUrl: 'https://termix.example.com' }, 'work');
    assert(partial.mode === 'open', `without a host id the mode must be 'open', got ${partial.mode}`);
    assert(partial.url === 'https://termix.example.com/', `the fallback must be the bare install URL, got ${partial.url}`);
    assert(!partial.url.includes('view='), 'the fallback must NOT use a view param — that gates the user into a terminal with no host');
    assert(/host id/i.test(partial.hint), `the degraded hint must name the missing setting: ${partial.hint}`);

    const full = termixLinkFor(cfg, 'work');
    assert(full.mode === 'attach' && full.url === termixAttachUrl(cfg, 'work'), 'attach mode must carry the attach URL');
    assert(/sign/i.test(full.hint), `the hint must warn that Termix may ask for a login: ${full.hint}`);
    assert(termixHomeUrl(null) === null && termixHomeUrl('https://x.test') === 'https://x.test/', 'home URL fallback shape');

    // The decoration contract used by GET /api/tmux: every session gains a
    // link, an unconfigured hub gains NOTHING (not a null field), and a
    // session whose name can't be linked is passed through untouched.
    const payload = { available: true, sessions: [{ name: 'work' }, { name: 'bad name' }] };
    assert(decorateSessionsWithTermix(payload, {}).sessions[0].termix === undefined,
      'an unconfigured hub must leave sessions exactly as they were');
    const decorated = decorateSessionsWithTermix(payload, cfg);
    assert(decorated.sessions[0].termix.url === termixAttachUrl(cfg, 'work'), 'decoration must attach the composed link');
    assert(decorated.sessions[1].termix === undefined, 'an unlinkable session name must be passed through undecorated');
    assert(payload.sessions[0].termix === undefined, 'decoration must not mutate the input payload');
    assert(decorateSessionsWithTermix({ available: false, sessions: [] }, cfg).sessions.length === 0,
      'a tmux-less host must decorate nothing and not throw');

    // Host id validation: it ends up in a URL, so only a positive integer.
    assert(validateTermixHostId('7') === 7 && validateTermixHostId(7) === 7, 'host id must coerce to a number');
    for (const bad of ['0', '-1', '1.5', 'abc', '', '  ', '7; drop', '1e3', null, undefined]) {
      let threw = false;
      try { validateTermixHostId(bad); } catch { threw = true; }
      assert(threw, `host id ${JSON.stringify(bad)} should be refused`);
    }

    // The API path. Singular — the API-keys doc's curl example says plural,
    // but the OpenAPI spec and Termix's own client both use the singular
    // form, and plural exists only as /host/db/hosts/export.
    assert(termixHostsUrl('https://termix.example.com/') === 'https://termix.example.com/host/db/host',
      `hosts URL shape drifted: ${termixHostsUrl('https://termix.example.com/')}`);

    // The 200 body shape is documented only in prose ("A list of SSH hosts"),
    // so the normalizer tolerates the three plausible envelopes and drops
    // anything without a usable integer id rather than trusting the payload.
    const rows = [{ id: 2, name: 'box', ip: '10.0.0.2', port: 22, username: 'me' }, { id: '1', name: 'other' }, { id: 'nope' }, null];
    for (const [label, envelope] of [['bare array', rows], ['{hosts}', { hosts: rows }], ['{data}', { data: rows }]]) {
      const parsed = normalizeTermixHosts(envelope);
      assert(parsed.length === 2, `${label} envelope should yield 2 usable hosts, got ${parsed.length}`);
      assert(parsed[0].id === 1 && parsed[1].id === 2, `${label} hosts must be sorted by id`);
      assert(parsed[1].enableTerminal === true, 'a host that omits enableTerminal must default to terminal-capable');
    }
    assert(normalizeTermixHosts(null).length === 0 && normalizeTermixHosts({ hosts: 'nope' }).length === 0,
      'a junk payload must normalize to an empty list, not throw');
    assert(normalizeTermixHosts([{ id: 3, enableTerminal: false }])[0].enableTerminal === false,
      'an explicitly terminal-disabled host must stay marked');

    // Auth failures must name the remedy, not the status code.
    assert(/API Keys/.test(describeTermixFailure(401, '')), 'a 401 must point at where API keys are made');
    assert(/API Keys/.test(describeTermixFailure(403, '')), 'a 403 must point at where API keys are made');
    assert(/port/.test(describeTermixFailure(404, '')), 'a 404 must raise the wrong-port possibility');
    assert(/HTTP 500/.test(describeTermixFailure(500, 'boom')), 'an unexpected status should still be reported');

    // Credential shape is presentational only — a warning, never a gate, and
    // never something we check by dialling out to find out.
    assert(looksLikeTermixApiKey('tmx_' + 'a'.repeat(64)), 'a well-formed API key must be recognized');
    assert(!looksLikeTermixApiKey('tmx_' + 'a'.repeat(63)) && !looksLikeTermixApiKey('eyJhbGciOi.jwt.here'),
      'a short key or a JWT must not be mistaken for an API key');

    console.log('smoke ok (termix deep links: view=terminal contract, encoding, hostId degradation, host-list normalization — no network)');
  }

  // --- settings API ------------------------------------------------------------
  const settingsGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(settingsGet0.settings, '/api/settings GET missing settings object');
  assert(settingsGet0.settings.host.value === '127.0.0.1', `settings host mismatch: ${JSON.stringify(settingsGet0.settings.host)}`);
  assert(settingsGet0.settings.host.source === 'flag', `settings host source should be 'flag' (--host was passed), got ${settingsGet0.settings.host.source}`);
  assert(settingsGet0.settings.port.value === port, `settings port mismatch: ${JSON.stringify(settingsGet0.settings.port)}`);
  assert(settingsGet0.settings.port.source === 'flag', `settings port source should be 'flag' (--port was passed), got ${settingsGet0.settings.port.source}`);
  assert(settingsGet0.settings.token.set === false && settingsGet0.settings.token.masked === null, 'settings token should start unset');
  assert(settingsGet0.configPath === join(configDir, 'config.json'), `settings configPath mismatch: ${settingsGet0.configPath}`);
  assert(/restart/i.test(settingsGet0.note || ''), 'settings note should mention restart');

  const settingsBadKey = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: '9.9.9.9' })
  });
  assert(settingsBadKey.status === 400, `settings POST with a host key should 400, got ${settingsBadKey.status}`);

  const settingsSetTok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'sekret-http-token' })
  }).then((r) => r.json());
  assert(settingsSetTok.ok && settingsSetTok.restartRequired === true, `settings token set failed: ${JSON.stringify(settingsSetTok)}`);

  const settingsConfigAfterSet = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(settingsConfigAfterSet.token === 'sekret-http-token', 'settings POST token did not persist to config.json');

  const settingsGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(settingsGet1.settings.token.set === true, 'settings token.set should be true after POST');
  assert(settingsGet1.settings.token.masked === 'sekr…', `settings token.masked mismatch: ${settingsGet1.settings.token.masked}`);

  const settingsClearTok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: null })
  }).then((r) => r.json());
  assert(settingsClearTok.ok, `settings token clear failed: ${JSON.stringify(settingsClearTok)}`);

  const settingsConfigAfterClear = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('token' in settingsConfigAfterClear), 'settings POST token:null did not clear the key');

  console.log('smoke ok (settings API: GET shape + POST token set/clear round-trip + 400 on host)');

  // --- settings API: opt-in per-project default epics (defaultEpics) --------
  // Fixture-only: reuses `epicRes` (the "Smoke epic" the issues domain creates,
  // in THIS fixture repo) as the epic id mapped into the config — never touches
  // a real repo. It comes through the shared fixture so `node scripts/smoke.mjs
  // settings` creates it on demand instead of depending on the issues domain
  // having run first.
  const epicRes = await fixtures.smokeEpic();
  const defaultEpicsGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(defaultEpicsGet0.defaultEpics && typeof defaultEpicsGet0.defaultEpics === 'object' && !Array.isArray(defaultEpicsGet0.defaultEpics),
    `/api/settings GET missing a defaultEpics object: ${JSON.stringify(defaultEpicsGet0.defaultEpics)}`);
  assert(!defaultEpicsGet0.defaultEpics[projectId], 'defaultEpics should start empty for the fixture project');

  const defaultEpicsSet1 = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { bug: epicRes.id, feature: null } } })
  }).then((r) => r.json());
  assert(defaultEpicsSet1.ok && defaultEpicsSet1.restartRequired === false,
    `defaultEpics set failed (or wrongly required a restart): ${JSON.stringify(defaultEpicsSet1)}`);

  const configAfterDefaultEpics1 = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterDefaultEpics1.defaultEpics?.[projectId]?.bug === epicRes.id,
    `defaultEpics did not persist to config.json: ${JSON.stringify(configAfterDefaultEpics1.defaultEpics)}`);
  assert(configAfterDefaultEpics1.defaultEpics[projectId].feature === null, 'defaultEpics feature:null did not persist as null');

  const defaultEpicsGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(defaultEpicsGet1.defaultEpics[projectId].bug === epicRes.id,
    `defaultEpics GET round-trip mismatch: ${JSON.stringify(defaultEpicsGet1.defaultEpics)}`);

  // A second POST touching only `task` must merge, not clobber, the `bug`
  // mapping already saved above.
  const defaultEpicsSet2 = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { task: epicRes.id } } })
  }).then((r) => r.json());
  assert(defaultEpicsSet2.ok, `defaultEpics merge-set failed: ${JSON.stringify(defaultEpicsSet2)}`);
  const configAfterMerge = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterMerge.defaultEpics[projectId].bug === epicRes.id && configAfterMerge.defaultEpics[projectId].task === epicRes.id,
    `defaultEpics merge clobbered a previously-set intent: ${JSON.stringify(configAfterMerge.defaultEpics[projectId])}`);

  // Validation: bad epic id, bad intent key, and bad top-level shape must all 400.
  const defaultEpicsBadId = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { bug: 'not a valid id!' } } })
  });
  assert(defaultEpicsBadId.status === 400, `defaultEpics with a bad epic id should 400, got ${defaultEpicsBadId.status}`);

  const defaultEpicsBadIntent = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { notarealintent: epicRes.id } } })
  });
  assert(defaultEpicsBadIntent.status === 400, `defaultEpics with an unknown intent key should 400, got ${defaultEpicsBadIntent.status}`);

  const defaultEpicsBadShape = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: 'nope' })
  });
  assert(defaultEpicsBadShape.status === 400, `defaultEpics with a non-object value should 400, got ${defaultEpicsBadShape.status}`);

  // A rejected write must not have partially applied — bug/task mappings
  // from before the bad requests above must be untouched.
  const configAfterBadRequests = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterBadRequests.defaultEpics[projectId].bug === epicRes.id && configAfterBadRequests.defaultEpics[projectId].task === epicRes.id,
    'a rejected defaultEpics POST should not have mutated config.json');

  console.log('smoke ok (settings API: defaultEpics round-trip + merge + validation rejection)');

  // --- settings API: Termix linkage (address + credential storage) ----------
  // The storage half of the deep-link feature. The whole point of these
  // assertions is that storage stays storage: saving a base URL and a
  // credential contacts NOTHING, and the credential round-trips to config.json
  // but the GET must never hand it back in the clear — the same contract
  // /api/usage is held to.
  const termixSecret = 'termix-api-secret-value';
  const termixGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(termixGet0.termix, '/api/settings GET missing termix block');
  assert(termixGet0.termix.baseUrl.value === null && termixGet0.termix.baseUrl.source === 'default',
    `termix baseUrl should start unset: ${JSON.stringify(termixGet0.termix.baseUrl)}`);
  assert(termixGet0.termix.token.set === false && termixGet0.termix.token.masked === null,
    `termix token should start unset: ${JSON.stringify(termixGet0.termix.token)}`);

  const termixSet = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'https://termix.example.com/', token: termixSecret } })
  }).then((r) => r.json());
  assert(termixSet.ok, `termix save failed: ${JSON.stringify(termixSet)}`);

  const termixConfigAfterSet = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(termixConfigAfterSet.termix.baseUrl === 'https://termix.example.com',
    `termix baseUrl should persist normalized (no trailing slash): ${termixConfigAfterSet.termix.baseUrl}`);
  assert(termixConfigAfterSet.termix.token === termixSecret, 'termix token did not persist to config.json');

  const termixGet1Res = await fetch(`http://127.0.0.1:${port}/api/settings`);
  const termixGet1Text = await termixGet1Res.text();
  assert(!termixGet1Text.includes(termixSecret), '/api/settings response must never contain termix token material');
  const termixGet1 = JSON.parse(termixGet1Text);
  assert(termixGet1.termix.baseUrl.value === 'https://termix.example.com' && termixGet1.termix.baseUrl.source === 'config',
    `termix baseUrl round-trip mismatch: ${JSON.stringify(termixGet1.termix.baseUrl)}`);
  assert(termixGet1.termix.token.set === true && termixGet1.termix.token.masked === 'term…',
    `termix token should read back set + masked only: ${JSON.stringify(termixGet1.termix.token)}`);

  // A partial patch leaves the other key alone.
  await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'http://10.9.9.9:8080' } })
  }).then((r) => r.json());
  const termixConfigPartial = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(termixConfigPartial.termix.baseUrl === 'http://10.9.9.9:8080', 'termix partial patch did not update baseUrl');
  assert(termixConfigPartial.termix.token === termixSecret, 'termix partial patch should not disturb the token');

  for (const [label, badBody] of [
    ['non-http scheme', { termix: { baseUrl: 'javascript:alert(1)' } }],
    ['bare hostname', { termix: { baseUrl: 'termix.example.com' } }],
    ['url with a query string', { termix: { baseUrl: 'https://termix.example.com/?a=1' } }],
    ['unknown sub-key', { termix: { apiKey: 'x' } }],
    ['empty object', { termix: {} }],
    ['non-object', { termix: 'https://termix.example.com' }],
  ]) {
    const bad = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badBody)
    });
    assert(bad.status === 400, `termix POST with ${label} should 400, got ${bad.status}`);
  }

  const termixClear = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: null, token: null } })
  }).then((r) => r.json());
  assert(termixClear.ok, `termix clear failed: ${JSON.stringify(termixClear)}`);
  const termixConfigAfterClear = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('termix' in termixConfigAfterClear), 'clearing both termix keys should drop the whole termix object');
  assert(termixConfigAfterClear.defaultEpics, 'termix clear should not disturb the rest of config.json');

  console.log('smoke ok (settings API: termix baseUrl/token round-trip, partial patch, URL validation, credential never echoed)');

  // --- settings API: termix.hostId + the deep-link decoration (bd-console-4w7)
  // NOTHING in this block contacts a Termix, and the ordering is load-bearing:
  // it runs AFTER the clear above, so no credential is stored while it runs.
  // That is what makes the two host-lookup assertions safe — /api/termix/hosts
  // is the only route that can dial out, and both calls below hit a
  // precondition (no base URL / no token) that refuses BEFORE any request is
  // attempted. The deep link itself is composed from stored strings, so the
  // payoff can be verified end-to-end with no Termix in existence.
  const txGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert('hostId' in txGet0.termix, '/api/settings GET must expose a termix.hostId block');
  assert(txGet0.termix.hostId.value === null && txGet0.termix.hostId.source === 'default',
    `termix.hostId should start unset: ${JSON.stringify(txGet0.termix.hostId)}`);

  const txBadHostId = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { hostId: 'not-a-number' } })
  });
  assert(txBadHostId.status === 400, `a non-integer termix.hostId should 400, got ${txBadHostId.status}`);

  const txLookupNoUrl = await fetch(`http://127.0.0.1:${port}/api/termix/hosts`);
  assert(txLookupNoUrl.status === 400, `/api/termix/hosts without a base URL should 400, got ${txLookupNoUrl.status}`);
  assert(/base URL/i.test((await txLookupNoUrl.json()).error || ''), 'the 400 should name the missing base URL');

  // `.invalid` is the reserved TLD that can never resolve — belt and braces on
  // top of "no token is stored, so the lookup refuses before dialling".
  const txSet = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'https://smoke.termix.invalid/', hostId: '4' } })
  }).then((r) => r.json());
  assert(txSet.ok && txSet.restartRequired === false, `termix hostId set failed: ${JSON.stringify(txSet)}`);

  const txConfig = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(txConfig.termix.hostId === 4, `termix.hostId must persist as a number, got ${JSON.stringify(txConfig.termix.hostId)}`);
  assert(!('token' in txConfig.termix), 'this block must never store a Termix credential');

  const txGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(txGet1.termix.hostId.value === 4 && txGet1.termix.hostId.source === 'config',
    `termix.hostId should read back from config: ${JSON.stringify(txGet1.termix.hostId)}`);

  const txLookupNoToken = await fetch(`http://127.0.0.1:${port}/api/termix/hosts`);
  assert(txLookupNoToken.status === 400, `/api/termix/hosts without a token should 400, got ${txLookupNoToken.status}`);
  assert(/token/i.test((await txLookupNoToken.json()).error || ''), 'the 400 should name the missing token');

  // The payoff: with Termix configured, GET /api/tmux carries a ready-made
  // deep link per session — and carries no credential of any kind.
  const txTmux = await fetch(`http://127.0.0.1:${port}/api/tmux`).then((r) => r.json());
  for (const s of txTmux.sessions) {
    assert(s.termix && s.termix.mode === 'attach', `a configured hub must decorate ${s.name} with an attach link: ${JSON.stringify(s.termix)}`);
    const expectedQuery = new URLSearchParams({ view: 'terminal', hostId: '4', tmuxSession: s.name }).toString();
    assert(s.termix.url === `https://smoke.termix.invalid/?${expectedQuery}`,
      `decorated link shape mismatch for ${s.name}: ${s.termix.url}`);
  }

  const txClear = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: null, token: null, hostId: null } })
  }).then((r) => r.json());
  assert(txClear.ok, `termix clear failed: ${JSON.stringify(txClear)}`);
  const txConfigCleared = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('termix' in txConfigCleared), 'clearing every termix key should remove the whole nested object');

  console.log(`smoke ok (settings API: termix.hostId round-trip, host lookup refuses before dialling, ${txTmux.sessions.length} session(s) decorated)`);

  // --- `bd-console settings` set/list/unset round-trip (Feature 1) -----------
  const settingsConfigDir = join(tempRoot, 'settings-config');
  const settingsSystemdDir = join(tempRoot, 'settings-systemd');
  mkdirSync(settingsConfigDir, { recursive: true });
  mkdirSync(settingsSystemdDir, { recursive: true });
  const settingsEnv = {
    ...process.env,
    BD_CONSOLE_CONFIG_DIR: settingsConfigDir,
    BD_CONSOLE_SYSTEMD_DIR: settingsSystemdDir
  };

  function runSettings(args) {
    return execFileSync(process.execPath, [serverEntry, 'settings', ...args], {
      cwd: process.cwd(),
      env: settingsEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  runSettings(['set', 'host', '10.1.2.3']);
  runSettings(['set', 'port', '9191']);
  runSettings(['set', 'token', 'sekret-token-value']);
  runSettings(['set', 'persist', 'false']);

  const settingsListOut = runSettings(['list']);
  assert(settingsListOut.includes('10.1.2.3'), `settings list missing host round-trip:\n${settingsListOut}`);
  assert(settingsListOut.includes('9191'), `settings list missing port round-trip:\n${settingsListOut}`);
  assert(/token\s+set \(sekr\.\.\.\)/.test(settingsListOut), `settings list did not mask the token:\n${settingsListOut}`);
  assert(!settingsListOut.includes('sekret-token-value'), 'settings list leaked the full token value');
  assert(/persist\s+false/.test(settingsListOut), `settings list missing persist round-trip:\n${settingsListOut}`);
  assert(/\bconfig\b/.test(settingsListOut), `settings list did not report "config" as a source:\n${settingsListOut}`);

  const settingsConfigPath = join(settingsConfigDir, 'config.json');
  const settingsConfig1 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(settingsConfig1.host === '10.1.2.3', 'settings set host did not persist to config.json');
  assert(settingsConfig1.port === 9191, 'settings set port did not persist to config.json');
  assert(settingsConfig1.token === 'sekret-token-value', 'settings set token did not persist to config.json');
  assert(settingsConfig1.persist === false, 'settings set persist did not persist to config.json');

  runSettings(['unset', 'token']);
  const settingsConfig2 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(!('token' in settingsConfig2), 'settings unset token did not remove the key');
  assert(settingsConfig2.host === '10.1.2.3', 'settings unset token should not disturb other keys');

  let badSetFailed = false;
  try {
    runSettings(['set', 'port', '99999']);
  } catch {
    badSetFailed = true;
  }
  assert(badSetFailed, 'settings set with an out-of-range port should fail');

  // termix.* takes the same CLI path, nested one level down in config.json,
  // and its credential is masked in `list` exactly like the write token's.
  runSettings(['set', 'termix.baseUrl', 'https://termix.example.com/']);
  runSettings(['set', 'termix.token', 'termix-cli-secret']);
  runSettings(['set', 'termix.hostId', '12']);
  const settingsConfig3 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(settingsConfig3.termix.baseUrl === 'https://termix.example.com', 'settings set termix.baseUrl did not persist normalized');
  assert(settingsConfig3.termix.token === 'termix-cli-secret', 'settings set termix.token did not persist to config.json');
  assert(settingsConfig3.termix.hostId === 12, `settings set termix.hostId must persist as a number: ${JSON.stringify(settingsConfig3.termix.hostId)}`);

  const settingsListOut2 = runSettings(['list']);
  assert(/termix\.hostId\s+12/.test(settingsListOut2), `settings list missing termix.hostId:\n${settingsListOut2}`);
  assert(settingsListOut2.includes('https://termix.example.com'), `settings list missing termix.baseUrl:\n${settingsListOut2}`);
  assert(/termix\.token\s+set \(term\.\.\.\)/.test(settingsListOut2), `settings list did not mask termix.token:\n${settingsListOut2}`);
  assert(!settingsListOut2.includes('termix-cli-secret'), 'settings list leaked the full termix token value');

  runSettings(['unset', 'termix.token']);
  const settingsConfig4 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(!('token' in settingsConfig4.termix), 'settings unset termix.token did not remove the key');
  assert(settingsConfig4.termix.baseUrl === 'https://termix.example.com', 'settings unset termix.token should not disturb termix.baseUrl');

  let badTermixSetFailed = false;
  try {
    runSettings(['set', 'termix.baseUrl', 'not-a-url']);
  } catch {
    badTermixSetFailed = true;
  }
  assert(badTermixSetFailed, 'settings set with a non-URL termix.baseUrl should fail');

  let badHostIdSetFailed = false;
  try {
    runSettings(['set', 'termix.hostId', 'seven']);
  } catch {
    badHostIdSetFailed = true;
  }
  assert(badHostIdSetFailed, 'settings set with a non-integer termix.hostId should fail');

  console.log('smoke ok (settings set/list/unset round-trip, incl. nested termix.* + masked credential)');
}
