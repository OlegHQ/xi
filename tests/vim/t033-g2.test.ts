import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const artifact = resolve(root, '.artifacts/editor/t033-preview.json');

await new Promise<void>((resolvePromise, reject) => {
  const child = spawn('python3', ['spikes/editor/t033-pty.py'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) reject(new Error(`T033-PTY:${code}: ${stdout}${stderr}`));
    else resolvePromise();
  });
});

const raw = JSON.parse(await readFile(artifact, 'utf8')) as unknown;
assert.equal(typeof raw, 'object');
if (raw === null || typeof raw !== 'object') throw new Error('T033-artifact-object');
const result = (raw as { result?: unknown }).result;
assert.equal(typeof result, 'object');
if (result === null || typeof result !== 'object') throw new Error('T033-artifact-result');
const record = result as { text?: unknown; commands?: unknown; localTyping?: { samples?: unknown }; terminal?: { restored?: unknown } };
assert.equal(record.text, 'Xalpha beta\nXalpha beta', 'T033-PTY-MULTI-INSERT-01 both carets edit through one terminal stream');
assert.deepEqual(record.commands, ['mode-transition', 'insert-key', 'leave-mode'], 'T033-PTY-ROUTING-01 parser and owned insert planner receive the terminal keys');
assert.ok(typeof record.localTyping?.samples === 'number' && record.localTyping.samples >= 2, 'T033-PTY-PROFILE-01 records local keypress timings');
assert.equal(record.terminal?.restored, true, 'T033-PTY-TERMINAL-01 terminal modes restore on exit');
console.log('T033 G2 PTY preview passed: atomic multi-cursor insert, parser routing, document-owned rendering and local typing profile');
