#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_PORT = 4180;
const DEFAULT_HOST = '127.0.0.1';
const CONFIG_FILE = 'bd-console.json';
const BLOCK_START = '<!-- BEGIN BD-CONSOLE SETUP -->';
const BLOCK_END = '<!-- END BD-CONSOLE SETUP -->';
const SKIP_DIRS = new Set([
  '.git', '.beads', 'node_modules', '.next', 'dist', 'build', 'coverage', 'vendor', 'tmp'
]);
const PREFERRED_DOC_ROOTS = ['docs', '.planning', 'planning', 'specs', 'notes', 'design', 'guides'];

function usage() {
  console.log(`bd-console-init

Usage:
  bd-console-init [--repo PATH] [--host HOST] [--port PORT] [--token VALUE]
                  [--apply-agent-docs] [--create-missing-agent-docs]
                  [--force-config] [--dry-run]

What it does:
  - checks that the target repo already has .beads/
  - refreshes .beads/issues.jsonl
  - writes bd-console.json if missing
  - optionally updates AGENTS.md / CLAUDE.md with bd-console guidance
`);
}

function parseArgs(argv) {
  const out = {
    repo: null,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: '',
    applyAgentDocs: false,
    createMissingAgentDocs: false,
    forceConfig: false,
    dryRun: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i] || '';
    else if (a === '--apply-agent-docs') out.applyAgentDocs = true;
    else if (a === '--create-missing-agent-docs') out.createMissingAgentDocs = true;
    else if (a === '--force-config') out.forceConfig = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error(`invalid port: ${out.port}`);
  }
  return out;
}

function findWorkspace(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.beads'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runBd(workspace, args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: workspace, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function dirHasMarkdown(dir, depth = 0) {
  if (depth > 2) return false;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.planning') continue;
      if (await dirHasMarkdown(join(dir, entry.name), depth + 1)) return true;
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.md')) return true;
  }
  return false;
}

async function detectDocRoots(workspace) {
  let entries = [];
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.planning') continue;
    if (await dirHasMarkdown(join(workspace, entry.name))) candidates.push(entry.name);
  }
  const preferred = PREFERRED_DOC_ROOTS.filter((name) => candidates.includes(name));
  if (preferred.length) return preferred;
  if (candidates.length > 0 && candidates.length <= 4) return candidates.sort();
  return [];
}

async function hasRootMarkdown(workspace) {
  let entries = [];
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
}

function renderConfig({ host, port, token, docRoots }) {
  const config = { port, host };
  if (docRoots.length) config.docRoots = docRoots;
  if (token) config.token = token;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function renderAgentBlock() {
  return `${BLOCK_START}
## bd-console

This repo uses \`bd-console\` as a local dashboard for beads issues and markdown docs.

- Start it from the repo root with \`bd-console --repo .\` if installed globally, or \`node /path/to/bd-console/serve.mjs --repo .\` if running from a clone.
- Keep \`.beads/issues.jsonl\` fresh after non-UI beads mutations with \`bd export -o .beads/issues.jsonl\`.
- Treat \`triage\` as the default inbox label for captured ideas.
- Preserve document provenance with \`doc:<path>\` labels when an idea comes from a specific markdown file.
- Prefer \`127.0.0.1\` unless you intentionally need network access; if you expose the dashboard, set a write token in \`bd-console.json\` or \`BD_CONSOLE_TOKEN\`.
- Before telling someone to use the dashboard, verify that \`bd-console\` starts and that \`http://localhost:4180\` or the configured host/port loads.
${BLOCK_END}
`;
}

function applyBlock(existing, block) {
  if (existing.includes(BLOCK_START) && existing.includes(BLOCK_END)) {
    return existing.replace(new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`), `${block}\n`);
  }
  const trimmed = existing.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

async function upsertGuideFile(path, createIfMissing, dryRun) {
  const block = renderAgentBlock();
  const exists = existsSync(path);
  if (!exists && !createIfMissing) return { path, changed: false, skipped: true };
  const original = exists ? await readFile(path, 'utf8') : `# ${path.endsWith('AGENTS.md') ? 'AGENTS' : 'Project Instructions for AI Agents'}\n`;
  const next = applyBlock(original, block);
  if (next === original) return { path, changed: false, skipped: false };
  if (!dryRun) await writeFile(path, next, 'utf8');
  return { path, changed: true, skipped: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const workspace = resolve(args.repo || findWorkspace(process.cwd()) || process.cwd());
  if (!existsSync(join(workspace, '.beads'))) {
    throw new Error(`no .beads/ workspace found at or above ${workspace}`);
  }

  const bdWhere = await runBd(workspace, ['where']);
  if (!bdWhere.ok) throw new Error((bdWhere.stderr || 'bd where failed').trim());

  const exportResult = await runBd(workspace, ['export', '-o', '.beads/issues.jsonl']);
  if (!exportResult.ok) throw new Error((exportResult.stderr || 'bd export failed').trim());

  const docRoots = await detectDocRoots(workspace);
  const rootMarkdown = await hasRootMarkdown(workspace);
  const configDocRoots = rootMarkdown && docRoots.length < 2 ? [] : docRoots;
  const configPath = join(workspace, CONFIG_FILE);
  const configExists = existsSync(configPath);
  const wrote = [];

  if (!configExists || args.forceConfig) {
    const configText = renderConfig({ host: args.host, port: args.port, token: args.token, docRoots: configDocRoots });
    if (!args.dryRun) await writeFile(configPath, configText, 'utf8');
    wrote.push(`${CONFIG_FILE}${configExists ? ' (overwritten)' : ''}`);
  }

  const guideUpdates = [];
  if (args.applyAgentDocs) {
    guideUpdates.push(await upsertGuideFile(join(workspace, 'AGENTS.md'), args.createMissingAgentDocs, args.dryRun));
    guideUpdates.push(await upsertGuideFile(join(workspace, 'CLAUDE.md'), args.createMissingAgentDocs, args.dryRun));
  }

  console.log(`workspace: ${workspace}`);
  console.log(`bd where: ${bdWhere.stdout.trim()}`);
  console.log(`export: refreshed .beads/issues.jsonl`);
  console.log(`doc roots: ${configDocRoots.length ? configDocRoots.join(', ') : '(auto-discovery recommended)'}`);
  if (wrote.length) console.log(`config: ${args.dryRun ? 'would write' : 'wrote'} ${wrote.join(', ')}`);
  else console.log(`config: kept existing ${CONFIG_FILE}`);
  if (args.applyAgentDocs) {
    for (const update of guideUpdates) {
      if (update.skipped) console.log(`${update.path}: skipped (missing; rerun with --create-missing-agent-docs to create it)`);
      else if (update.changed) console.log(`${update.path}: ${args.dryRun ? 'would update' : 'updated'}`);
      else console.log(`${update.path}: already current`);
    }
  } else {
    console.log('agent docs: unchanged (pass --apply-agent-docs to update AGENTS.md / CLAUDE.md)');
  }
  console.log('');
  console.log('Next steps:');
  console.log('1. Start the dashboard with `bd-console --repo .` or `node /path/to/bd-console/serve.mjs --repo .`.');
  console.log(`2. Open http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}`);
  console.log('3. If you edit beads outside the dashboard, run `bd export -o .beads/issues.jsonl` again.');
}

main().catch((err) => {
  console.error(`bd-console-init: ${err.message}`);
  process.exit(1);
});
