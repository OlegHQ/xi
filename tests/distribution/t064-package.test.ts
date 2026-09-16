import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const audit = runAudit(['--check']);
assert.equal(audit.status, 0, `T064-PACKAGE-AUDIT-01 current target passes: ${audit.stderr}`);
assert.match(audit.stdout, /"target":\s*"linux-arm64"/u, 'T064-PACKAGE-AUDIT-02 records the advertised target');
assert.match(audit.stdout, /core-linux-arm64/u, 'T064-PACKAGE-AUDIT-03 records the OpenTUI native package');
assert.match(audit.stdout, /libopentui\.so/u, 'T064-PACKAGE-AUDIT-04 records the native library');

const musl = runAudit(['--check', '--target', 'linux-arm64-musl']);
assert.equal(musl.status, 0, `T064-PACKAGE-AUDIT-05 recorded musl asset passes: ${musl.stderr}`);
assert.match(musl.stdout, /core-linux-arm64-musl/u, 'T064-PACKAGE-AUDIT-06 records the musl native package');

const unsupported = runAudit(['--check', '--target', 'linux-riscv64']);
assert.notEqual(unsupported.status, 0, 'T064-PACKAGE-AUDIT-FAIL-01 missing target asset fails closed');
assert.match(unsupported.stderr, /no OpenTUI native asset/u, 'T064-PACKAGE-AUDIT-FAIL-02 reports the missing native asset');

const releaseDirectory = mkdtempSync(join(tmpdir(), 'xi-t064-release-'));
process.once('exit', () => { rmSync(releaseDirectory, { recursive: true, force: true }); });
const release = spawnSync('bun', ['run', 'tools/package-release.ts', '--output', releaseDirectory], { encoding: 'utf8' });
assert.equal(release.status, 0, `T064-PACKAGE-RELEASE-01 staging command succeeds: ${release.stderr}`);
const executable = join(releaseDirectory, 'xi');
const manifestPath = join(releaseDirectory, 'manifest.json');
assert.ok(existsSync(executable), 'T064-PACKAGE-RELEASE-02 staging includes the executable');
assert.ok(existsSync(manifestPath), 'T064-PACKAGE-RELEASE-03 staging includes a manifest');
assert.ok(existsSync(join(releaseDirectory, 'THIRD-PARTY-NOTICES.md')), 'T064-PACKAGE-RELEASE-04 staging includes dependency notices');
assert.ok(existsSync(join(releaseDirectory, 'native-assets.sha256')), 'T064-PACKAGE-RELEASE-05 staging includes native checksums');
assert.ok(existsSync(join(releaseDirectory, 'licenses', '@opentui__core', 'LICENSE')), 'T064-PACKAGE-RELEASE-06 staging includes license text');
const releaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly target?: unknown; readonly binarySha256?: unknown; readonly openTui?: unknown };
assert.equal(releaseManifest.target, 'linux-arm64', 'T064-PACKAGE-RELEASE-07 manifest records the target');
assert.equal(typeof releaseManifest.binarySha256, 'string', 'T064-PACKAGE-RELEASE-08 manifest records binary checksum');
const isolatedHealth = spawnSync(executable, ['--health'], {
  cwd: releaseDirectory,
  encoding: 'utf8',
  env: { ...process.env, HOME: releaseDirectory, XDG_CONFIG_HOME: join(releaseDirectory, 'config'), PATH: join(releaseDirectory, 'empty-bin') },
});
assert.equal(isolatedHealth.status, 0, 'T064-PACKAGE-RELEASE-09 staged binary runs without workspace dependencies');
assert.match(isolatedHealth.stdout, /OpenTUI workbench available/u, 'T064-PACKAGE-RELEASE-10 staged binary health check works');

console.log('T064 package audit/release passed target, native checksum, notice, isolated staging and missing-asset failure probes');

function runAudit(args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync('bun', ['run', 'tools/package-audit.ts', ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
