import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { parseCliArgs } from '../../apps/xi/src/cli';
import packageJson from '../../package.json' with { type: 'json' };

type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

const help = await run(['--help']);
assert.equal(help.code, 0, 'T064-CLI-HELP-01 exits successfully');
assert.match(help.stdout, /Usage: xi \[options\] \[file\[:line\]\]/u, 'T064-CLI-HELP-01 prints file-line usage');
assert.match(help.stdout, /-c, --config PATH/u, 'T064-CLI-CONFIG-01 documents the explicit config path');

const config = parseCliArgs(['--config', 'custom.toml', 'sample.txt'], '0.0.1');
assert.deepEqual(config, { kind: 'launch', configPath: 'custom.toml', fileArgument: 'sample.txt' }, 'T064-CLI-CONFIG-02 explicit config parses as a launch action');

const configEquals = parseCliArgs(['--config=custom.toml', 'sample.txt'], '0.0.1');
assert.deepEqual(configEquals, { kind: 'launch', configPath: 'custom.toml', fileArgument: 'sample.txt' }, 'T064-CLI-CONFIG-03 equals-form config parses as a launch action');

assert.deepEqual(parseCliArgs(['--config'], '0.0.1'), { kind: 'error', text: 'xi: --config requires a path\n' }, 'T064-CLI-CONFIG-04 missing config path is rejected at the CLI boundary');

const version = await run(['--version']);
assert.equal(version.code, 0, 'T064-CLI-VERSION-01 exits successfully');
assert.equal(version.stdout, `xi ${packageJson.version}\n`, 'T064-CLI-VERSION-01 prints package version');

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
