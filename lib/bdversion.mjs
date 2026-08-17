// lib/bdversion.mjs — installed vs. latest `bd` (beads CLI) version check.
//
// getBdVersionInfo() NEVER throws: every failure mode (bd missing, network
// down, GitHub rate-limited, malformed output) comes back as a field on the
// result, never a rejected promise — a dashboard must not lose the local
// "installed version" fact just because the network is unavailable.
//
// Two things are deliberately factored out as pure, import-free functions so
// scripts/smoke.mjs can assert them without spawning `bd` or the network:
//   - parseBdVersionStdout(stdout): `bd version` stdout -> version string.
//   - compareVersions(a, b) / isBehind(installed, latest): semver-ish compare
//     that tolerates `v` prefixes and non-numeric suffixes (pre-release
//     tags), and never reports "behind" for an equal-or-newer install.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { run } from './exec.mjs';

const REPO = 'gastownhall/beads';
const GITHUB_OK_TTL_MS = 6 * 60 * 60 * 1000;   // 6h — GitHub's unauthenticated API is 60 req/hr/IP.
const GITHUB_ERR_TTL_MS = 15 * 60 * 1000;      // 15m negative-cache on any failure (offline, rate-limited, ...).
const FETCH_TIMEOUT_MS = 5000;

function cachePath() {
  return join(CONFIG_DIR, 'bd-version-cache.json');
}

// BD_CONSOLE_GITHUB_API_BASE lets tests point this at an unroutable/stub host
// instead of the real GitHub API — same pattern as BD_CONSOLE_CLAUDE_DIR/
// BD_CONSOLE_CODEX_DIR in lib/usage.mjs.
function githubApiBase() {
  return process.env.BD_CONSOLE_GITHUB_API_BASE || 'https://api.github.com';
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/smoke.mjs)
// ---------------------------------------------------------------------------

// `bd version` stdout looks like:
//   bd version 1.1.0 (8e4e59d39: HEAD@8e4e59d39f34)
// Tolerant of a leading `v`, extra whitespace, and garbage/empty input (->
// null rather than throwing).
export function parseBdVersionStdout(stdout) {
  const text = String(stdout || '');
  const m = text.match(/version\s+v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?)/i);
  return m ? m[1] : null;
}

// GitHub releases' `tag_name` is usually `v1.1.0` — strip a leading v/V.
// Returns null for anything that isn't a parseable version-ish string.
export function normalizeTag(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return null;
  const s = tag.trim().replace(/^[vV]/, '');
  return /\d/.test(s) ? s : null;
}

// Splits a version string into {core:[nums], prerelease} or null if it has
// no digits at all (malformed). Non-numeric core segments become 0 rather
// than throwing/NaN-poisoning the comparison.
function toParts(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^[vV]/, '');
  if (!s || !/\d/.test(s)) return null;
  const [core, ...rest] = s.split(/[-+]/);
  const prerelease = rest.length ? rest.join('-') : null;
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { core: parts, prerelease };
}

// -1 (a < b), 0 (equal), 1 (a > b), or null if either side is unparseable.
// A prerelease suffix sorts below the same core version without one (so
// "1.2.0-beta" < "1.2.0"), matching plain semver precedence closely enough
// for "is there something newer" purposes.
export function compareVersions(a, b) {
  const pa = toParts(a);
  const pb = toParts(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] || 0;
    const y = pb.core[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease) return pa.prerelease === pb.prerelease ? 0 : (pa.prerelease < pb.prerelease ? -1 : 1);
  return 0;
}

// null when either version is missing/unparseable; false on equal-or-newer
// (never nag someone running a pre-release or the latest already) — only
// true when installed is strictly older than latest.
export function isBehind(installed, latest) {
  const cmp = compareVersions(installed, latest);
  if (cmp === null) return null;
  return cmp < 0;
}

// ---------------------------------------------------------------------------
// Binary detection — resolve every `bd` on PATH ourselves (rather than
// trusting bd's own stderr warning text) so the UI can list the exact paths.
// Two dedupe passes matter here: PATH itself can contain the same directory
// many times over (this dev machine has ~/.local/bin repeated 8x), and a
// PATH entry can be a symlink (e.g. an nvm shim) pointing at the same real
// file another entry already found — neither should inflate the count.
// ---------------------------------------------------------------------------
export function findBdBinaries(binName = 'bd') {
  const rawDirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  const seenDirs = new Set();
  const seenReal = new Set();
  const out = [];
  for (const dir of rawDirs) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const candidate = join(dir, binName);
    let st;
    try { st = statSync(candidate); } catch { continue; }
    if (!st.isFile()) continue;
    let real;
    try { real = realpathSync(candidate); } catch { real = candidate; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    out.push(real);
  }
  return out;
}

// Best-effort install-flavor guess from the ACTIVE binary's resolved path
// (i.e. binaries[0] — the one `bd` on PATH actually runs) rather than any
// binary found. This matters: on a machine where an install-script binary
// shadows a stale npm-global one (the exact trap this module exists to
// catch), the update hint must target the one actually in effect — telling
// someone to `npm i -g` when a `~/.local/bin/bd` shadows it would "succeed"
// and change nothing.
export function detectFlavor(primaryPath) {
  if (!primaryPath) return 'unknown';
  const p = primaryPath.toLowerCase();
  if (p.includes('node_modules') || p.includes('/.nvm/') || p.includes('/npm/')) return 'npm';
  if (p.includes('homebrew') || p.includes('linuxbrew') || p.includes('/cellar/')) return 'brew';
  // The official install script drops a plain binary, typically under
  // ~/.local/bin or /usr/local/bin — anything ending in a bare `bin/bd` that
  // isn't one of the above is the best guess we can make without a receipt
  // file to check.
  if (/\/bin\/bd$/.test(p)) return 'script';
  return 'unknown';
}

export function updateCommandFor(flavor) {
  if (flavor === 'brew') return 'brew upgrade beads';
  if (flavor === 'npm') return 'npm i -g @beads/bd@latest';
  if (flavor === 'script') return 'curl -sSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash';
  return null;
}

// ---------------------------------------------------------------------------
// `bd version` invocation
// ---------------------------------------------------------------------------
async function runBdVersion() {
  const r = await run('bd', ['version'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Latest-release lookup — in-memory cache backed by an on-disk mirror (under
// CONFIG_DIR, BD_CONSOLE_CONFIG_DIR-aware) so a server restart doesn't re-hit
// GitHub's unauthenticated 60/hr/IP rate limit immediately.
// ---------------------------------------------------------------------------
let memCache = null; // { at, ttl, tag: string|null }

function readDiskCache() {
  try {
    const data = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (data && typeof data.at === 'number' && typeof data.ttl === 'number') return data;
  } catch { /* missing/corrupt — treat as no cache */ }
  return null;
}
function writeDiskCache(entry) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(entry), 'utf8');
  } catch { /* best-effort only — never let a cache-write failure surface */ }
}

async function fetchLatestTag() {
  const url = `${githubApiBase()}/repos/${REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bd-console' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.tag_name !== 'string') throw new Error('missing tag_name');
  return data.tag_name;
}

// Returns { tag, source } — tag is the raw (possibly v-prefixed) GitHub tag
// or null; source is 'github' (freshly fetched this call), 'cache' (served
// from memory or disk without a network call), or null (no data available,
// fresh or cached).
async function resolveLatestTag({ force = false } = {}) {
  const now = Date.now();

  if (!force && memCache && (now - memCache.at) < memCache.ttl) {
    return { tag: memCache.tag, source: memCache.tag ? 'cache' : null };
  }
  if (!force && !memCache) {
    const disk = readDiskCache();
    if (disk && (now - disk.at) < disk.ttl) {
      memCache = disk;
      return { tag: disk.tag, source: disk.tag ? 'cache' : null };
    }
  }

  try {
    const tag = await fetchLatestTag();
    memCache = { at: now, ttl: GITHUB_OK_TTL_MS, tag };
    writeDiskCache(memCache);
    return { tag, source: 'github' };
  } catch {
    memCache = { at: now, ttl: GITHUB_ERR_TTL_MS, tag: null };
    writeDiskCache(memCache);
    return { tag: null, source: null };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function getBdVersionInfo({ force = false } = {}) {
  const checkedAt = Date.now();
  let installed = null;
  let error = null;

  try {
    const r = await runBdVersion();
    if (r.ok) {
      installed = parseBdVersionStdout(r.stdout);
      if (!installed) error = 'could not parse `bd version` output';
    } else {
      error = (r.stderr || r.stdout || 'bd version failed').trim() || 'bd version failed';
    }
  } catch (e) {
    error = (e && e.message) || 'bd version failed';
  }

  let binaries = [];
  try { binaries = findBdBinaries(); } catch { binaries = []; }
  const multipleBinaries = binaries.length > 1;
  const installFlavor = detectFlavor(binaries[0] || null);
  const updateHint = installed ? updateCommandFor(installFlavor) : null;

  let latest = null;
  let latestSource = null;
  try {
    const r = await resolveLatestTag({ force });
    latest = normalizeTag(r.tag);
    latestSource = r.source;
  } catch {
    latest = null;
    latestSource = null;
  }

  const behind = isBehind(installed, latest);

  return {
    installed, latest, behind, checkedAt, latestSource,
    binaries, multipleBinaries, installFlavor, updateHint, error
  };
}
