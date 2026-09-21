import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../.artifacts/reference/helix/master');
const helix = join(root, 'target/release/hx');
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), '079a789e8cb08ead67f19e1971a1b7438b37354b');
assert.match(execFileSync(helix, ['--version'], { encoding: 'utf8' }), /079a789e/u);
const fixture = join(import.meta.dir, '../fixtures/config/helix-master.toml');
const source = readFileSync(fixture, 'utf8');
const config: unknown = Bun.TOML.parse(source);
const ledger = JSON.parse(readFileSync(join(import.meta.dir, '../../docs/configuration-ledger.json'), 'utf8')) as { items: { reference: string; path: string; variant?: string }[] };
for (const item of ledger.items.filter((entry) => entry.reference === 'master' && entry.path !== 'editor.gutters.code-action-hint')) {
  const value = item.path.endsWith('.*') ? readPath(config, item.path.slice(0, -2)) : readPath(config, item.path);
  if (item.path.endsWith('.*')) {
    assert.ok(value !== undefined && typeof value === 'object' && value !== null && Object.values(value).some((part) => Array.isArray(part) && part.includes(item.variant)), `master fixture includes ${item.variant}`);
  } else {
    assert.notEqual(value, undefined, `master fixture includes ${item.path}`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'xi-helix-master-acceptance-'));
try {
  const environment = { ...process.env, HOME: temporary, XDG_DATA_HOME: join(temporary, 'data'), HELIX_RUNTIME: join(root, 'runtime') };
  const output = execFileSync(helix, ['-c', fixture, '--health'], { cwd: temporary, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.ok(output.includes('Config file:') && !output.includes('Configuration file malformed'), 'T036-MASTER-FIXTURE-ACCEPT-01 pinned master accepts every listed setting together');
  const invalid = join(temporary, 'invalid.toml');
  writeFileSync(invalid, `${source}\n[editor.gutters.code-action-hint]\n`);
  const rejected = execFileSync(helix, ['-c', invalid, '--health'], { cwd: temporary, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.match(rejected, /unknown field `code-action-hint`/u, 'T036-MASTER-GUTTER-EMPTY-REJECT-01 pinned master rejects the documented empty gutter table');
  const architecture = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
  assert.ok(architecture);
  const stable = join(import.meta.dir, `../../.artifacts/reference/helix/25.07.1/helix-25.07.1-${architecture}-linux/hx`);
  for (const section of ['diagnostics', 'diff', 'spacer']) {
    writeFileSync(invalid, `[editor.gutters.${section}]\n`);
    const stableOutput = execFileSync(stable, ['-c', invalid, '--health'], { cwd: temporary, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.match(stableOutput, new RegExp(`unknown field \x60${section}\x60`, 'u'), `T036-STABLE-GUTTER-EMPTY-REJECT-01 pinned stable rejects the documented empty ${section} table`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
