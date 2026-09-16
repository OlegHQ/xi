import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

const script = resolve(import.meta.dir, 't081-cli-pty.py');
const result = spawnSync('python3', [script], { encoding: 'utf8' });
assert.equal(result.status, 0, `T081 CLI PTY failed: ${result.stdout}\n${result.stderr}`);
console.log((result.stdout ?? '').trim());
