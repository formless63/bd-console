// lib/usage/read.mjs — the bounded, never-throwing disk access the provider
// adapters share, plus the two value coercions that kept getting rewritten.
//
// Every function here obeys the same rules the adapters do: READ-ONLY (nothing
// in lib/usage/ ever writes a file, creates a directory or refreshes a token),
// NEVER THROWS (a missing/corrupt/unreadable path is an empty result, not an
// exception), and BOUNDED (readSlice reads a byte range, never a whole file, so
// a multi-MB log costs a fixed number of bytes no matter how long it grew).
//
// Nothing here is allowed to open a credential file. The adapters name the
// files they refuse to read in their own headers; this module simply never
// grows a "read the token" helper for them to reach for.
import { readdir, readFile, open, stat } from 'node:fs/promises';

// readdir that answers [] for a missing/unreadable directory. "The directory
// isn't there" is a normal answer for every one of these providers (the CLI
// simply isn't installed), not an error worth propagating.
export async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// JSON.parse of a file, or null. Covers both "no such file" and "the CLI was
// mid-write and left half an object behind".
export async function safeReadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// Byte-range read. Never loads a whole file when the caller only wants a slice
// of it — this is what lets the Gemini adapter answer from a 32KB head plus a
// 256KB tail of a log that may be hundreds of MB.
export async function readSlice(path, start, length) {
  if (length <= 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

// "Does this directory exist?" — the not-installed probe. A path that exists
// but isn't a directory counts as absent: a stray file named ~/.kimi-code is
// not an installation.
export async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Timestamps arrive in two shapes in the wild: epoch-ms numbers and ISO
// strings (Kimi's state.json v1 vs v2, Gemini's UpdatedAt vs last_modified_time,
// Claude's resets_at). Accept both rather than assuming the newer one.
export function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Liveness is a SECONDARY signal only — pids get reused, and the process may
// belong to another user (EPERM still means "something is alive with that
// pid"). Whatever heartbeat/log-freshness signal the adapter has is what
// decides `state`; this only separates "gone quiet but still there" from "gone".
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM' ? true : false;
  }
}
