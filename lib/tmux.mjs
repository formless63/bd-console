// lib/tmux.mjs — tmux session introspection + literal prompt injection.
//
// All tmux interaction goes through execFile('tmux', [...args]) — args
// arrays only, never shell strings. Every function degrades gracefully when
// the tmux binary is missing or no tmux server is running: callers get
// { available: false } / empty results / {ok:false, error} rather than a
// thrown exception.
import { execFile } from 'node:child_process';

// Defense in depth: tmux's `-t` target syntax has its own mini-grammar
// (session:window.pane, `=exact`, etc.) so even though we always pass args
// arrays (never a shell string), a crafted session "name" could still change
// which target a command resolves to. Reject anything that isn't a plain
// token before it ever reaches a tmux invocation.
export const SESSION_NAME_RE = /^[A-Za-z0-9_.:@-]+$/;

// Field separator for tmux format strings. tmux's format engine escapes most
// C0 control characters (e.g. 0x1f, 0x01, 0x1e all come back as literal
// "\NNN" text) when they appear literally in a -F string, but passes tab
// (0x09) through unescaped — so tab it is. Session names/paths/titles
// containing a literal tab are vanishingly rare and, worst case, just shift
// a field boundary rather than corrupting anything unsafely.
const SEP = '\t';

function runTmux(args, opts = {}) {
  return new Promise((resolveP) => {
    execFile('tmux', args, { maxBuffer: 8 * 1024 * 1024, timeout: 10000, ...opts }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

// Parses a tmux epoch-seconds format field into a Number, or null when the
// field is empty (tmux may print nothing for e.g. #{session_last_attached}
// on a session that's never been attached to) or non-positive/non-finite.
// Epoch 0 is treated the same as empty — "0" reads as "unset" here, not as
// the 1970 boundary, since that's the only sense tmux uses it in practice.
function parseEpochSeconds(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// listSessions(): merges `tmux list-sessions` with `tmux list-panes -a` into
// [{ name, created, attached, windows, activity, lastAttached, panes: [{command, cwd, title}] }].
// `activity`/`lastAttached` are epoch seconds (Number) or null when tmux
// reports them empty/unset — see parseEpochSeconds above.
// Returns { available: false, sessions: [] } if tmux is absent or no server
// is running (list-sessions exits non-zero in both cases) — never throws.
export async function listSessions() {
  const sessionsRes = await runTmux([
    'list-sessions', '-F',
    `#{session_name}${SEP}#{session_created}${SEP}#{session_attached}${SEP}#{session_windows}${SEP}#{session_activity}${SEP}#{session_last_attached}`
  ]);
  if (!sessionsRes.ok) return { available: false, sessions: [] };

  const sessions = new Map();
  for (const line of sessionsRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, windows, activity, lastAttached] = line.split(SEP);
    if (!name) continue;
    sessions.set(name, {
      name,
      created: Number(created) || 0,
      attached: Number(attached) || 0,
      windows: Number(windows) || 0,
      activity: parseEpochSeconds(activity),
      lastAttached: parseEpochSeconds(lastAttached),
      panes: []
    });
  }

  // Pane cwd is how the UI infers which repo/agent a session is running —
  // always included. A failure here just means panes stay empty; the
  // session list itself is still useful.
  const panesRes = await runTmux([
    'list-panes', '-a', '-F', `#{session_name}${SEP}#{pane_current_command}${SEP}#{pane_current_path}${SEP}#{pane_title}`
  ]);
  if (panesRes.ok) {
    for (const line of panesRes.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [session, command, cwd, title] = line.split(SEP);
      const s = sessions.get(session);
      if (s) s.panes.push({ command: command || '', cwd: cwd || '', title: title || '' });
    }
  }

  return { available: true, sessions: Array.from(sessions.values()) };
}

// hasSession(name): boolean, never throws.
export async function hasSession(name) {
  if (!SESSION_NAME_RE.test(name || '')) return false;
  const r = await runTmux(['has-session', '-t', name]);
  return r.ok;
}

// capturePane(name, lines=120): text of the last N lines of a pane's
// scrollback + visible content. Returns '' on any failure (missing session,
// tmux absent, etc.) rather than throwing.
export async function capturePane(name, lines = 120) {
  if (!SESSION_NAME_RE.test(name || '')) return '';
  const n = Number.isFinite(Number(lines)) && Number(lines) > 0 ? Math.floor(Number(lines)) : 120;
  const r = await runTmux(['capture-pane', '-p', '-t', name, '-S', `-${n}`]);
  return r.ok ? r.stdout : '';
}

// sendPrompt(name, text): LITERAL injection into an existing interactive
// session. The -l flag on the first send-keys is required so prompt text is
// never interpreted as tmux key names; Enter is sent as a second, separate
// call. Validates the session exists first. Returns {ok:true} or
// {ok:false, error}; never throws.
export async function sendPrompt(name, text) {
  if (!SESSION_NAME_RE.test(name || '')) return { ok: false, error: 'bad session name' };

  const exists = await hasSession(name);
  if (!exists) return { ok: false, error: 'tmux session not found' };

  const r1 = await runTmux(['send-keys', '-t', name, '-l', '--', String(text ?? '')]);
  if (!r1.ok) return { ok: false, error: (r1.stderr || 'tmux send-keys failed').trim() };

  const r2 = await runTmux(['send-keys', '-t', name, 'Enter']);
  if (!r2.ok) return { ok: false, error: (r2.stderr || 'tmux send-keys (Enter) failed').trim() };

  return { ok: true };
}
