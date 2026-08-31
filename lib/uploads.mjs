// lib/uploads.mjs — writes browser-supplied files into a directory on disk.
// Backs POST /api/files/upload directly (bd-console-cox.2) and is reused by
// POST /api/tmux/create (bd-console-cox.1) for "attach files, then launch".
import { writeFile, rename, link, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

export const UPLOAD_MAX_FILES = 20;
export const UPLOAD_FILE_MAX_BYTES = 4 * 1024 * 1024; // per file, decoded
export const UPLOAD_TOTAL_MAX_BYTES = 12 * 1024 * 1024; // decoded, all files combined

// writeUploadedFiles(dir, files, { overwrite }): files = [{name, content}],
// content base64-encoded. Every filename is reduced to its basename() before
// it ever reaches a path — that is the whole defense against a crafted
// "../../etc/passwd" or an absolute path arriving as a "name": no matter what
// the client sends, the write can only ever land inside `dir`.
//
// Returns {ok:true, written:[name...], skipped:[{name, reason}]} for a
// request that made it to the per-file stage, or {ok:false, status, error}
// for a request-level failure (bad dir, too many files, bad name, decode
// failure, over a size cap) — those are rejected before anything is written.
// A single file that already exists (and overwrite isn't set) or fails to
// write is reported in `skipped`, not a batch failure: the rest still land.
export async function writeUploadedFiles(dir, files, { overwrite = false } = {}) {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, status: 400, error: 'no files given' };
  if (files.length > UPLOAD_MAX_FILES) {
    return { ok: false, status: 400, error: `too many files (max ${UPLOAD_MAX_FILES})` };
  }

  let dirStat;
  try { dirStat = await stat(dir); } catch { return { ok: false, status: 400, error: `directory does not exist: ${dir}` }; }
  if (!dirStat.isDirectory()) return { ok: false, status: 400, error: `not a directory: ${dir}` };

  let totalBytes = 0;
  const decoded = [];
  for (const f of files) {
    const rawName = typeof f?.name === 'string' ? f.name.trim() : '';
    const name = basename(rawName);
    if (!name || name === '.' || name === '..') {
      return { ok: false, status: 400, error: `bad file name: ${JSON.stringify(f?.name ?? '')}` };
    }
    if (typeof f?.content !== 'string') {
      return { ok: false, status: 400, error: `${name}: content must be a base64 string` };
    }
    let buf;
    try { buf = Buffer.from(f.content, 'base64'); } catch { buf = null; }
    if (!buf) return { ok: false, status: 400, error: `${name}: could not decode content` };
    if (buf.length > UPLOAD_FILE_MAX_BYTES) {
      return { ok: false, status: 400, error: `${name}: exceeds ${Math.round(UPLOAD_FILE_MAX_BYTES / (1024 * 1024))}MB per-file limit` };
    }
    totalBytes += buf.length;
    if (totalBytes > UPLOAD_TOTAL_MAX_BYTES) {
      return { ok: false, status: 400, error: `upload exceeds ${Math.round(UPLOAD_TOTAL_MAX_BYTES / (1024 * 1024))}MB total limit` };
    }
    decoded.push({ name, buf });
  }

  const written = [];
  const skipped = [];
  for (const { name, buf } of decoded) {
    const full = join(dir, name);
    if (!overwrite && existsSync(full)) {
      skipped.push({ name, reason: 'already exists' });
      continue;
    }
    // tmp + rename, same as /api/doc and the formula writer: a crash or full
    // disk mid-write must never leave a half-written file at the real name.
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, buf);
      if (overwrite) {
        await rename(tmp, full);
      } else {
        // Publish with an atomic no-clobber operation. The existsSync check
        // above is only an early UX response; another request may create the
        // name before this one reaches disk.
        await link(tmp, full);
        await unlink(tmp);
      }
      written.push(name);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      skipped.push({ name, reason: e.message });
    }
  }
  return { ok: true, written, skipped };
}
