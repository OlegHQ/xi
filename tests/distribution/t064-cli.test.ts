import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';

type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

const help = await run(['--help']);
assert.equal(help.code, 0, 'T064-CLI-HELP-01 exits successfully');
assert.match(help.stdout, /Usage: xi \[options\] \[file\[:line\]\]/u, 'T064-CLI-HELP-01 prints file-line usage');

const version = await run(['--version']);
assert.equal(version.code, 0, 'T064-CLI-VERSION-01 exits successfully');
assert.match(version.stdout, /xi 0\.0\.1/u, 'T064-CLI-VERSION-01 prints pinned application version');

const health = await run(['--health']);
assert.equal(health.code, 0, 'T064-CLI-HEALTH-01 exits successfully');
assert.match(health.stdout, /OpenTUI workbench available/u, 'T064-CLI-HEALTH-01 reports local UI runtime');

console.log('T064 CLI probes passed help, version and health without an external editor engine');

function run(args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'apps/xi/src/main.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
