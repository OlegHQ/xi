import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const architecture = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
assert.notEqual(architecture, undefined, 'T036-SCROLLOFF-HELIX-01 pinned Helix has a supported host binary');
const helix = join(import.meta.dir, '../../.artifacts/reference/helix/25.07.1/helix-25.07.1-' + architecture + '-linux/hx');
assert.equal(existsSync(helix), true, 'T036-SCROLLOFF-HELIX-02 pinned Helix binary exists');

const temporary = mkdtempSync('/tmp/xi-helix-scrolloff-');
try {
  const fixture = join(temporary, 'helix-25.07.1.toml');
  writeFileSync(fixture, readFileSync(join(import.meta.dir, '../fixtures/config/helix-25.07.1.toml')));
  const output = execFileSync(helix, ['-c', fixture, '--health'], {
    cwd: temporary,
    env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(output, /Config file:/, 'T036-SCROLLOFF-HELIX-03 Helix accepts the canonical config fixture');
  for (const [name, source, valid] of [
    ['shell args', '[editor]\nshell = ["bash", "--noprofile", "-c"]\n', true],
    ['large scrolloff', '[editor]\nscrolloff = 1001\n', true],
    ['zero trigger', '[editor]\ncompletion-trigger-len = 0\n', true],
    ['max trigger', '[editor]\ncompletion-trigger-len = 255\n', true],
    ['overflow trigger', '[editor]\ncompletion-trigger-len = 256\n', false],
  ] as const) {
    writeFileSync(fixture, source);
    const result = execFileSync(helix, ['-c', fixture, '--health'], {
      cwd: temporary,
      env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(/Configuration file malformed/u.test(result), !valid, `pinned Helix ${name} boundary`);
  }
  console.log('T036-SCROLLOFF-HELIX-03-PART2 passed: pinned Helix 25.07.1 accepted the canonical config fixture containing editor.scrolloff.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
