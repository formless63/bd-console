#!/usr/bin/env node
// bd-console's smoke suite: one entry point, one fixture, per-domain modules.
//
//   npm run smoke                # everything except the opt-in domains
//   npm run smoke -- usage       # one domain
//   node scripts/smoke.mjs usage # same thing
//   node scripts/smoke.mjs docs formulas   # several
//   node scripts/smoke.mjs browser         # opt-in: real Chrome, layout only
//   node scripts/smoke.mjs --list          # what the domain names are
//
// The suite used to be a single 4,000-line file, which made it the most
// frequent merge conflict in the repo: every parallel agent appended to the
// same tail (bd-console-m90). The sections themselves did not change in the
// split — they were moved verbatim into scripts/smoke/<domain>.mjs, and every
// one of them still runs on `npm run smoke`.
//
// The expensive part (a temp git+beads repo, `scripts/init.mjs`, and a
// `serve.mjs` on a scratch port with an isolated BD_CONSOLE_CONFIG_DIR) is
// built once by scripts/smoke/harness.mjs and handed to each module as `ctx`.
// The harness also pins BD_CONSOLE_CLAUDE_DIR/_CODEX_DIR/_KIMI_DIR/_GEMINI_DIR
// at empty fixture dirs before anything spawns, so no section — present or
// future — can read the real ~/.claude, ~/.codex, ~/.kimi-code or ~/.gemini.
// See that file's header for the full isolation contract.
//
// Adding coverage: put it in the domain module it belongs to (or add a new
// module and list it in DOMAINS below). scripts/check-imports.mjs walks
// scripts/** recursively, so a new module is import-checked automatically.

import { setup, teardown } from './smoke/harness.mjs';
import { runBaseline } from './smoke/baseline.mjs';
import { runIssues } from './smoke/issues.mjs';
import { runTmux } from './smoke/tmux.mjs';
import { runScheduler } from './smoke/scheduler.mjs';
import { runSettings } from './smoke/settings.mjs';
import { runRegistry } from './smoke/registry.mjs';
import { runDocs } from './smoke/docs.mjs';
import { runCli } from './smoke/cli.mjs';
import { runUsage } from './smoke/usage.mjs';
import { runVersions } from './smoke/versions.mjs';
import { runRouting } from './smoke/routing.mjs';
import { runFormulas } from './smoke/formulas.mjs';
import { runBrowser } from './smoke/browser.mjs';

// Order matters: it is the order the sections ran in as one file, so anything
// that leaned on state an earlier section left behind still sees it.
//
// A domain may be marked OPT-IN (4th field), which keeps it out of the default
// run while leaving it listed by --list and runnable by name. Only `browser`
// is opt-in today: it boots a real Chrome and costs ~10-20s, which is not a
// price the default fast loop should pay. See scripts/smoke/browser.mjs.
const DOMAINS = [
  ['issues', runIssues, 'issue creation, links/relationships, and the pure derivations over them'],
  ['tmux', runTmux, 'tmux sessions API, agent detection, process/host health'],
  ['scheduler', runScheduler, 'prompt scheduler and saved prompts'],
  ['settings', runSettings, 'settings over HTTP and CLI, including the Termix linkage'],
  ['registry', runRegistry, 'project registration and per-project git insight'],
  ['docs', runDocs, 'doc reading/writing/creation and doc navigation'],
  ['cli', runCli, 'daemon lifecycle, systemd unit, update --dry-run, first run'],
  ['usage', runUsage, 'claude/codex/kimi/gemini usage adapters, history, harness'],
  ['versions', runVersions, 'bd + Claude Code/Codex CLI version checks'],
  ['routing', runRouting, 'hash routes, the hub-route contract, the learn layer'],
  ['formulas', runFormulas, 'formulas and molecules: derivations, routes, authoring'],
  ['browser', runBrowser, 'layout/stacking/scroll/hit-testing in a real Chrome', true],
];

const args = process.argv.slice(2);

if (args.includes('--list') || args.includes('-l')) {
  console.log('smoke domains (default: all except the opt-in ones):\n');
  for (const [name, , blurb, optIn] of DOMAINS) {
    console.log(`  ${name.padEnd(10)} ${blurb}${optIn ? '  [opt-in: run it by name]' : ''}`);
  }
  console.log('\n  node scripts/smoke.mjs <domain> [<domain>...]');
  process.exit(0);
}

const requested = args.filter((a) => !a.startsWith('-'));
const unknown = requested.filter((a) => !DOMAINS.some(([name]) => name === a));
if (unknown.length) {
  console.error(`smoke: unknown domain(s): ${unknown.join(', ')}`);
  console.error(`smoke: known domains: ${DOMAINS.map(([n]) => n).join(', ')}`);
  process.exit(1);
}

const selected = requested.length
  ? DOMAINS.filter(([name]) => requested.includes(name))
  : DOMAINS.filter(([, , , optIn]) => !optIn);

let ctx;
try {
  ctx = await setup();
  // Always run: it proves the fixture the other modules assume is really being
  // served, and it is where the seed/quick issues come from.
  await runBaseline(ctx);

  for (const [, runDomain] of selected) await runDomain(ctx);

  console.log(`smoke ok: ${ctx.seedId}, ${ctx.state.quickRes.id}`);
} catch (err) {
  console.error(`smoke failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await teardown(ctx);
}
