// lib/cliversions.mjs — installed vs. latest version check for the Claude
// Code and Codex CLIs, mirroring lib/bdversion.mjs's `bd` (beads CLI) check.
//
// getCliVersions() NEVER throws: every failure mode (binary missing, network
// down, npm registry down/rate-limited, malformed output) comes back as a
// field on the result, never a rejected promise — a dashboard must not lose
// the local "installed version" fact just because the network is
// unavailable.
//
// The semver-ish parsing/compare plumbing is NOT reimplemented here — it's
// imported straight from lib/bdversion.mjs (compareVersions, isBehind,
// normalizeTag, findBdBinaries), which already tolerates `v` prefixes,
// pre-release suffixes, and PATH-dedup correctly. Only the pieces that are
// genuinely different per-tool (the `--version` stdout shape, the version
// source being the npm registry instead of GitHub releases, and install
// flavor detection) are written fresh below.
//
// Like parseBdVersionStdout, parseCliVersionStdout(stdout) is a pure,
// import-free function so scripts/smoke.mjs can assert it without spawning
// `claude`/`codex` or touching the network.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { isBehind, normalizeTag, findBdBinaries } from './bdversion.mjs';

const NPM_OK_TTL_MS = 6 * 60 * 60 * 1000;   // 6h, same cadence as bdversion's GitHub cache.
const NPM_ERR_TTL_MS = 15 * 60 * 1000;      // 15m negative-cache on any failure (offline, rate-limited, ...).
const FETCH_TIMEOUT_MS = 5000;

// tool key -> { label, npmPackage } — the only per-tool wiring this module needs.
const TOOLS = {
  claude: { label: 'Claude Code', npmPackage: '@anthropic-ai/claude-code' },
  codex: { label: 'Codex', npmPackage: '@openai/codex' }
};

function cachePath() {
  return join(CONFIG_DIR, 'cli-version-cache.json');
}

// BD_CONSOLE_NPM_REGISTRY_BASE lets tests point this at an unroutable/stub
// host instead of the real npm registry — same pattern as
// BD_CONSOLE_GITHUB_API_BASE in lib/bdversion.mjs.
function npmRegistryBase() {
  return process.env.BD_CONSOLE_NPM_REGISTRY_BASE || 'https://registry.npmjs.org';
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/smoke.mjs)
// ---------------------------------------------------------------------------

// Real `--version` outputs:
//   claude --version -> "2.1.220 (Claude Code)"
//   codex --version  -> "codex-cli 0.144.1"
// Tolerant of a leading `v`, a leading non-numeric package-name prefix (the
// `codex-cli` in "codex-cli 0.144.1" has no digits, so it's never mistaken
// for the version itself), and garbage/empty input (-> null rather than
// throwing). Returns the first semver-ish token in the string.
export function parseCliVersionStdout(stdout) {
  const text = String(stdout || '');
  const m = text.match(/v?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Install flavor
//
// bdversion's detectFlavor() hardcodes a `/\/bin\/bd$/` regex for its
// "install script" fallback, which doesn't generalize to other binary names
// by substitution: on this machine `findBdBinaries('claude')` resolves
// (through the ~/.local/bin/claude symlink) to
// ~/.local/share/claude/versions/2.1.220 — no `bin/` segment at all — while
// `findBdBinaries('codex')` resolves to
// ~/.codex/packages/standalone/releases/<ver>-.../bin/codex, which DOES end
// in `bin/codex`. Neither of the official installers for these two tools
// drops a single stable `bin/<name>` file the way bd's curl-a-shell-script
// installer does, so reusing detectFlavor's regex as-is would misreport
// Claude Code as 'unknown'. Instead: reuse detectFlavor's npm/homebrew
// substring checks (those are genuinely tool-agnostic path-content checks)
// but treat anything else as 'native' — the standalone-binary installer
// flavor both of these CLIs actually ship, as opposed to bd's install
// *script* flavor.
export function detectCliFlavor(primaryPath) {
  if (!primaryPath) return 'unknown';
  const p = primaryPath.toLowerCase();
  if (p.includes('node_modules') || p.includes('/.nvm/') || p.includes('/npm/')) return 'npm';
  if (p.includes('homebrew') || p.includes('linuxbrew') || p.includes('/cellar/')) return 'brew';
  return 'native';
}

// Both CLIs have a genuine built-in `update` subcommand (verified via
// --help), which is why native/unknown falls back to it rather than to
// null — unlike bd, there's always something sensible to suggest.
export function updateCommandFor(tool, flavor) {
  const commands = {
    claude: {
      npm: 'npm i -g @anthropic-ai/claude-code@latest',
      brew: 'brew upgrade --cask claude-code',
      native: 'claude update',
      unknown: 'claude update'
    },
    codex: {
      npm: 'npm i -g @openai/codex@latest',
      brew: 'brew upgrade codex',
      native: 'codex update',
      unknown: 'codex update'
    }
  };
  return (commands[tool] && commands[tool][flavor]) || null;
}

// ---------------------------------------------------------------------------
// `<tool> --version` invocation
// ---------------------------------------------------------------------------
function runCliVersion(binName) {
  return new Promise((resolveP) => {
    execFile(binName, ['--version'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------------------------------------------------------------------------
// Latest-version lookup (npm registry) — in-memory cache backed by an
// on-disk mirror (under CONFIG_DIR, BD_CONSOLE_CONFIG_DIR-aware) so a server
// restart doesn't re-hit the registry immediately. ONE cache file holds both
// tools' entries keyed by tool name, so refreshing one tool's entry never
// clobbers the other's.
// ---------------------------------------------------------------------------
let memCache = null; // { claude?: {at, ttl, version}, codex?: {at, ttl, version} }

function readDiskCache() {
  try {
    const data = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* missing/corrupt — treat as no cache */ }
  return null;
}
function writeDiskCache(entry) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(entry), 'utf8');
  } catch { /* best-effort only — never let a cache-write failure surface */ }
}

// Lazily loads the whole (both-tools) cache object once per process, same
// as bdversion's memCache-is-null-once check — but here the unit is the
// shared object, not a single field, so a second tool's lookup sees the
// first tool's freshly written entry instead of stomping it.
function sharedCache() {
  if (!memCache) memCache = readDiskCache() || {};
  return memCache;
}

async function fetchLatestVersion(tool) {
  const url = `${npmRegistryBase()}/${TOOLS[tool].npmPackage}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.version !== 'string') throw new Error('missing version');
  return data.version;
}

// Returns { version, source } — version is the raw npm version string or
// null; source is 'npm' (freshly fetched this call), 'cache' (served from
// memory or disk without a network call), or null (no data available, fresh
// or cached).
async function resolveLatestVersion(tool, { force = false } = {}) {
  const now = Date.now();
  const cache = sharedCache();
  const cached = cache[tool];

  if (!force && cached && (now - cached.at) < cached.ttl) {
    return { version: cached.version, source: cached.version ? 'cache' : null };
  }

  try {
    const version = await fetchLatestVersion(tool);
    cache[tool] = { at: now, ttl: NPM_OK_TTL_MS, version };
    writeDiskCache(cache);
    return { version, source: 'npm' };
  } catch {
    cache[tool] = { at: now, ttl: NPM_ERR_TTL_MS, version: null };
    writeDiskCache(cache);
    return { version: null, source: null };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
async function getOneCliVersion(tool, { force = false } = {}) {
  const { label } = TOOLS[tool];
  const checkedAt = Date.now();
  let installed = null;
  let error = null;

  try {
    const r = await runCliVersion(tool);
    if (r.ok) {
      installed = parseCliVersionStdout(r.stdout);
      if (!installed) error = `could not parse \`${tool} --version\` output`;
    } else {
      error = (r.stderr || r.stdout || `${tool} --version failed`).trim() || `${tool} --version failed`;
    }
  } catch (e) {
    error = (e && e.message) || `${tool} --version failed`;
  }

  let binaries = [];
  try { binaries = findBdBinaries(tool); } catch { binaries = []; }
  const multipleBinaries = binaries.length > 1;
  const installFlavor = detectCliFlavor(binaries[0] || null);
  const updateHint = installed ? updateCommandFor(tool, installFlavor) : null;

  let latest = null;
  let latestSource = null;
  try {
    const r = await resolveLatestVersion(tool, { force });
    latest = normalizeTag(r.version);
    latestSource = r.source;
  } catch {
    latest = null;
    latestSource = null;
  }

  const behind = isBehind(installed, latest);

  return {
    tool, label, installed, latest, behind, checkedAt, latestSource,
    binaries, multipleBinaries, installFlavor, updateHint, error
  };
}

export async function getCliVersions({ force = false } = {}) {
  const [claude, codex] = await Promise.all([
    getOneCliVersion('claude', { force }),
    getOneCliVersion('codex', { force })
  ]);
  return { tools: { claude, codex } };
}
