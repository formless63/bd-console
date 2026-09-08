#!/usr/bin/env node
// Increment bd-console's stable SemVer without npm's implicit git tag/commit
// behavior. This is used by the version-bump workflow and is also available to
// maintainers as `npm run version:bump -- major|minor|patch`.

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASES = new Set(['major', 'minor', 'patch']);

export function nextVersion(version, release = 'patch') {
  const match = String(version || '').match(STABLE_SEMVER_RE);
  if (!match) throw new Error(`expected a stable SemVer version, got ${JSON.stringify(version)}`);
  if (!RELEASES.has(release)) throw new Error(`release must be major, minor, or patch; got ${JSON.stringify(release)}`);

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (release === 'major') { major += 1; minor = 0; patch = 0; }
  if (release === 'minor') { minor += 1; patch = 0; }
  if (release === 'patch') patch += 1;
  return `${major}.${minor}.${patch}`;
}

export function bumpPackageText(text, release = 'patch') {
  let pkg;
  try { pkg = JSON.parse(text); } catch (err) { throw new Error(`package.json is invalid JSON: ${err.message}`); }
  const current = pkg?.version;
  const next = nextVersion(current, release);
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionField = new RegExp(`("version"\\s*:\\s*)"${escaped}"`);
  if (!versionField.test(text)) throw new Error('could not locate package.json version field');
  return { current, next, text: text.replace(versionField, `$1"${next}"`) };
}

export function bumpPackageFile(packagePath, release = 'patch') {
  const source = readFileSync(packagePath, 'utf8');
  const result = bumpPackageText(source, release);
  const tempPath = `${packagePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, result.text, { mode: statSync(packagePath).mode & 0o777 });
    renameSync(tempPath, packagePath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* rename succeeded or no temp was written */ }
  }
  return result;
}

function main() {
  const release = process.argv[2] || 'patch';
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const result = bumpPackageFile(packagePath, release);
  console.log(`${result.current} -> ${result.next}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (err) {
    console.error(`bd-console version bump failed: ${err.message}`);
    process.exitCode = 1;
  }
}
