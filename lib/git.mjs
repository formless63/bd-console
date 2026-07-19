// lib/git.mjs — read-only git repository insights for the hub UI (per-project
// branch/remote/commit/dirty-state summary). All interaction goes through
// execFile('git', ['-C', repoPath, ...args]) — args arrays only, never a
// shell string. Every individual field is best-effort: a failing subcommand
// (no repo, no upstream, no remote, git binary missing, ...) yields null for
// that field alone, never a thrown error the caller has to handle specially.
import { execFile } from 'node:child_process';

const CACHE_TTL_MS = 15000;
const cache = new Map(); // repoPath -> { at: epochMs, value: insights|null }

const US = '\x1f'; // unit separator — safe field delimiter for `git log --format`

function git(repoPath, args) {
  return new Promise((resolveP) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolveP({ ok: !err, stdout: (stdout || '').trim(), stderr: stderr || '' });
      }
    );
  });
}

async function isGitRepo(repoPath) {
  const r = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

// webUrlFromRemote: derives a browsable https URL from an origin remote for
// github.com / gitlab.com / codeberg.org, handling both
// `git@host:owner/repo.git` (ssh, scp-like) and `https://host/owner/repo(.git)`
// forms. Returns null for any other host, or if the remote can't be parsed.
function webUrlFromRemote(remoteUrl) {
  if (!remoteUrl) return null;

  let host = null;
  let ownerRepo = null;

  let m = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (m) {
    [, host, ownerRepo] = m;
  } else {
    m = remoteUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (m) [, host, ownerRepo] = m;
  }

  if (!host || !ownerRepo) return null;
  const ALLOWED_HOSTS = new Set(['github.com', 'gitlab.com', 'codeberg.org']);
  if (!ALLOWED_HOSTS.has(host)) return null;
  return `https://${host}/${ownerRepo}`;
}

async function safe(fn) {
  try { return await fn(); } catch { return null; }
}

// getGitInsights(repoPath): { branch, remoteUrl, webUrl, lastCommit, commits7d,
// dirty, ahead, behind }, or null when repoPath isn't a git repo. Cached
// per-path for CACHE_TTL_MS so hub polling (many projects, frequent refresh)
// stays cheap.
export async function getGitInsights(repoPath) {
  const cached = cache.get(repoPath);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return cached.value;

  const repo = await safe(() => isGitRepo(repoPath));
  if (!repo) {
    const value = null;
    cache.set(repoPath, { at: Date.now(), value });
    return value;
  }

  const [branch, remoteUrl, lastCommit, commits7d, dirty, revs] = await Promise.all([
    safe(async () => {
      const r = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return r.ok && r.stdout ? r.stdout : null;
    }),
    safe(async () => {
      const r = await git(repoPath, ['remote', 'get-url', 'origin']);
      return r.ok && r.stdout ? r.stdout : null;
    }),
    safe(async () => {
      const r = await git(repoPath, ['log', '-1', `--format=%h${US}%s${US}%an${US}%ct`]);
      if (!r.ok || !r.stdout) return null;
      const [hash, subject, author, time] = r.stdout.split(US);
      if (!hash) return null;
      const t = Number(time);
      return { hash, subject: subject ?? '', author: author ?? '', time: Number.isFinite(t) ? t : null };
    }),
    safe(async () => {
      const r = await git(repoPath, ['rev-list', '--count', '--since=7.days', 'HEAD']);
      if (!r.ok || !r.stdout) return null;
      const n = Number(r.stdout);
      return Number.isFinite(n) ? n : null;
    }),
    safe(async () => {
      const r = await git(repoPath, ['status', '--porcelain']);
      if (!r.ok) return null;
      return r.stdout ? r.stdout.split('\n').filter((l) => l.trim()).length : 0;
    }),
    safe(async () => {
      const r = await git(repoPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      if (!r.ok || !r.stdout) return { ahead: null, behind: null };
      const parts = r.stdout.split(/\s+/);
      if (parts.length !== 2) return { ahead: null, behind: null };
      const behind = Number(parts[0]);
      const ahead = Number(parts[1]);
      return {
        behind: Number.isFinite(behind) ? behind : null,
        ahead: Number.isFinite(ahead) ? ahead : null
      };
    })
  ]);

  const value = {
    branch,
    remoteUrl,
    webUrl: webUrlFromRemote(remoteUrl),
    lastCommit,
    commits7d,
    dirty,
    ahead: revs ? revs.ahead : null,
    behind: revs ? revs.behind : null
  };

  cache.set(repoPath, { at: Date.now(), value });
  return value;
}
