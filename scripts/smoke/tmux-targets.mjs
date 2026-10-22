// Invoked by the tmux smoke domain in a child process with a private socket.
// Test text goes only to synthetic stdin receivers, never a user's agent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { capturePane, hasSession, inspectSession, sendPrompt } from '../../lib/tmux.mjs';

const root = process.argv[2];
assert(root, 'private fixture directory required');
const socket = join(root, 'socket');
assert.equal(process.env.TMUX, `${socket},0,0`, 'refuse to use the default tmux server');
const tmux = (...args) => execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
});
const receiver = join(root, 'receiver.mjs');
writeFileSync(receiver, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(process.argv[2], JSON.stringify(line) + '\\n');
  console.log('RECEIVED ' + line);
});
console.log('READY');
`);

try {
  // Multiple windows/panes plus a similarly named session catch accidental
  // prefix matching and delivery to the wrong active window or pane.
  tmux('new-session', '-d', '-s', 'target', '-n', 'first', process.execPath, receiver, join(root, 'first'));
  tmux('new-session', '-d', '-s', 'target-extra', process.execPath, receiver, join(root, 'extra'));
  tmux('new-window', '-t', '=target:', '-n', 'second', process.execPath, receiver, join(root, 'inactive'));
  tmux('split-window', '-h', '-t', '=target:', process.execPath, receiver, join(root, 'active'));
  tmux('select-pane', '-t', '=target:', '-T', 'fixture\ttitle');
  assert(await hasSession('target'));
  for (let i = 0; i < 50 && !(await capturePane('target')).includes('READY'); i++) await delay(50);
  assert((await capturePane('target')).includes('READY'), 'preview must resolve the exact session');
  assert(await inspectSession('target'), 'inspection must resolve the active window');

  const literal = 'fixture $(echo NOT_EXECUTED); "quotes" Enter';
  assert.deepEqual(await sendPrompt('target', literal), { ok: true });
  for (let i = 0; i < 50 && !existsSync(join(root, 'active')); i++) await delay(50);
  assert.equal(readFileSync(join(root, 'active'), 'utf8'), JSON.stringify(literal) + '\n',
    'literal text and Enter must reach the active pane exactly once');
  for (const name of ['first', 'inactive', 'extra']) assert(!existsSync(join(root, name)), `must not send to ${name}`);
  assert((await capturePane('target')).includes('RECEIVED'), 'preview must read the receiving pane');

  const receivingPane = tmux('display-message', '-p', '-t', '=target:', '#{pane_id}').trim();
  const otherPane = tmux('list-panes', '-t', '=target:', '-F', '#{pane_id}').trim().split('\n').find(id => id !== receivingPane);
  // A real tmux hook deterministically switches panes between the literal
  // send and Enter. Both must still arrive at the originally inspected pane.
  tmux('set-hook', '-g', 'after-send-keys', `select-pane -t ${otherPane}`);
  const switchedLiteral = 'fixture during pane switch';
  assert.deepEqual(await sendPrompt('target', switchedLiteral), { ok: true });
  tmux('set-hook', '-gu', 'after-send-keys');
  const expected = [literal, switchedLiteral].map(line => JSON.stringify(line) + '\n').join('');
  for (let i = 0; i < 50 && readFileSync(join(root, 'active'), 'utf8') !== expected; i++) await delay(50);
  assert.equal(readFileSync(join(root, 'active'), 'utf8'), expected, 'switching panes must not split prompt text from Enter');
  assert(!existsSync(join(root, 'inactive')), 'the newly active pane must receive neither text nor Enter');

  tmux('kill-session', '-t', '=target');
  assert.equal(await hasSession('target'), false, 'must not prefix-match target-extra');
  assert.deepEqual(await sendPrompt('target', 'must not arrive'), { ok: false, error: 'tmux session not found' });
  assert.equal(await capturePane('target'), '');
  assert.equal(await inspectSession('target'), null);
  assert(!existsSync(join(root, 'extra')), 'missing exact session must not receive via prefix matching');
} finally {
  try { tmux('kill-server'); } catch { /* already exited */ }
}
