import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const stagedDirectory = join(releaseDirectory, 'stage');
const assetsDirectory = join(releaseDirectory, 'assets');
const release = spawnSync('bun', ['run', 'tools/package-release.ts', '--output', stagedDirectory, '--release-directory', assetsDirectory], { encoding: 'utf8' });
assert.equal(release.status, 0, `T064-PACKAGE-RELEASE-01 staging command succeeds: ${release.stderr}`);
const executable = join(stagedDirectory, 'xi');
const manifestPath = join(stagedDirectory, 'manifest.json');
assert.ok(existsSync(executable), 'T064-PACKAGE-RELEASE-02 staging includes the executable');
assert.ok(existsSync(manifestPath), 'T064-PACKAGE-RELEASE-03 staging includes a manifest');
assert.ok(existsSync(join(stagedDirectory, 'THIRD-PARTY-NOTICES.md')), 'T064-PACKAGE-RELEASE-04 staging includes dependency notices');
assert.ok(existsSync(join(stagedDirectory, 'native-assets.sha256')), 'T064-PACKAGE-RELEASE-05 staging includes native checksums');
assert.ok(existsSync(join(stagedDirectory, 'licenses', '@opentui__core', 'LICENSE')), 'T064-PACKAGE-RELEASE-06 staging includes license text');
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { readonly version: string }).version;
const archiveName = `xi-${version}-linux-arm64.tar.gz`;
const archivePath = join(assetsDirectory, archiveName);
assert.ok(existsSync(archivePath), 'T064-PACKAGE-RELEASE-07 creates a versioned Linux ARM64 archive');
assert.ok(existsSync(join(assetsDirectory, 'SHA256SUMS')), 'T064-PACKAGE-RELEASE-08 creates an archive checksum manifest');
assert.ok(existsSync(join(assetsDirectory, 'install.sh')), 'T064-PACKAGE-RELEASE-09 stages the installer with release assets');
const releaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly target?: unknown; readonly binarySha256?: unknown; readonly openTui?: unknown };
assert.equal(releaseManifest.target, 'linux-arm64', 'T064-PACKAGE-RELEASE-10 manifest records the target');
assert.equal(typeof releaseManifest.binarySha256, 'string', 'T064-PACKAGE-RELEASE-11 manifest records binary checksum');
const isolatedHealth = spawnSync(executable, ['--health'], {
  cwd: stagedDirectory,
  encoding: 'utf8',
  env: { ...process.env, HOME: releaseDirectory, XDG_CONFIG_HOME: join(releaseDirectory, 'config'), PATH: join(releaseDirectory, 'empty-bin') },
});
assert.equal(isolatedHealth.status, 0, 'T064-PACKAGE-RELEASE-12 staged binary runs without workspace dependencies');
assert.match(isolatedHealth.stdout, /OpenTUI workbench available/u, 'T064-PACKAGE-RELEASE-13 staged binary health check works');
const configPty = spawnSync('python3', ['tests/e2e/config-user-pty.py', '--binary', executable], {
  cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: '' },
});
assert.equal(configPty.status, 0, `T064-PACKAGE-RELEASE-14 staged binary obeys XDG/HOME/CLI/workspace config paths: ${configPty.stdout ?? ''}${configPty.stderr ?? ''}`);

const simulatedRelease = join(releaseDirectory, 'release', 'download', `v${version}`);
mkdirSync(simulatedRelease, { recursive: true });
const targets = [
  { os: 'Linux', arch: 'x86_64', target: 'linux-x64' },
  { os: 'Linux', arch: 'aarch64', target: 'linux-arm64' },
  { os: 'Darwin', arch: 'x86_64', target: 'darwin-x64' },
  { os: 'Darwin', arch: 'arm64', target: 'darwin-arm64' },
];
const sums: string[] = [];
for (const { target } of targets) {
  const name = `xi-${version}-${target}.tar.gz`;
  const destination = join(simulatedRelease, name);
  copyFileSync(archivePath, destination);
  sums.push(`${createHash('sha256').update(readFileSync(destination)).digest('hex')}  ${name}`);
}
writeFileSync(join(simulatedRelease, 'SHA256SUMS'), `${sums.join('\n')}\n`);
const installer = join(process.cwd(), 'docs/installation/install.sh');
const installDirectory = join(releaseDirectory, 'home', '.local', 'bin');
const installerEnv = {
  ...process.env,
  PATH: `/usr/bin:/bin`,
  HOME: join(releaseDirectory, 'home'),
  XI_VERSION: `v${version}`,
  XI_RELEASE_URL: `file://${join(releaseDirectory, 'release')}`,
  XI_INSTALL_DIR: installDirectory,
};
for (const { os, arch, target } of targets) {
  const shimDirectory = join(releaseDirectory, `shim-${target}`);
  mkdirSync(shimDirectory);
  writeFileSync(join(shimDirectory, 'uname'), `#!/bin/sh\ncase "\${1:-}" in -s) echo ${os} ;; *) echo ${arch} ;; esac\n`);
  chmodSync(join(shimDirectory, 'uname'), 0o755);
  const installed = spawnSync('sh', [installer], { encoding: 'utf8', env: { ...installerEnv, PATH: `${shimDirectory}:/usr/bin:/bin` } });
  assert.equal(installed.status, 0, `T064-INSTALL-${target} installs from verified assets: ${installed.stderr}`);
}
assert.ok(existsSync(join(installDirectory, 'xi')), 'T064-INSTALL-02 installs executable into the selected user directory');
assert.ok(existsSync(join(installDirectory, 'xi-support', 'CATPPUCCIN-LICENSE')), 'T064-INSTALL-LICENSE-01 retains the theme attribution after installation');
assert.ok(existsSync(join(installDirectory, 'xi-support', 'licenses', '@opentui__core', 'LICENSE')), 'T064-INSTALL-LICENSE-02 retains dependency license texts after installation');
writeFileSync(join(installDirectory, 'xi'), 'existing working binary');
writeFileSync(join(simulatedRelease, archiveName), 'corrupted archive');
const arm64Shim = join(releaseDirectory, 'shim-linux-arm64');
const corrupted = spawnSync('sh', [installer], { encoding: 'utf8', env: { ...installerEnv, PATH: `${arm64Shim}:/usr/bin:/bin` } });
assert.notEqual(corrupted.status, 0, 'T064-INSTALL-03 rejects a corrupted archive');
assert.equal(readFileSync(join(installDirectory, 'xi'), 'utf8'), 'existing working binary', 'T064-INSTALL-04 failed verification preserves installed executable');
const unavailable = spawnSync('sh', [installer], { encoding: 'utf8', env: { ...installerEnv, PATH: `${arm64Shim}:/usr/bin:/bin`, XI_RELEASE_URL: `file://${join(releaseDirectory, 'missing-release')}` } });
assert.notEqual(unavailable.status, 0, 'T064-INSTALL-05 reports an unavailable release');
assert.match(unavailable.stderr, /Could not download Xi/u, 'T064-INSTALL-06 explains unavailable release assets');
assert.equal(readFileSync(join(installDirectory, 'xi'), 'utf8'), 'existing working binary', 'T064-INSTALL-07 unavailable release preserves installed executable');
const unsupportedShim = join(releaseDirectory, 'unsupported-shim');
mkdirSync(unsupportedShim);
writeFileSync(join(unsupportedShim, 'uname'), '#!/bin/sh\ncase "${1:-}" in -s) echo FreeBSD ;; *) echo x86_64 ;; esac\n');
chmodSync(join(unsupportedShim, 'uname'), 0o755);
const unsupportedHost = spawnSync('sh', [installer], { encoding: 'utf8', env: { ...installerEnv, PATH: `${unsupportedShim}:/usr/bin:/bin` } });
assert.notEqual(unsupportedHost.status, 0, 'T064-INSTALL-08 rejects unqualified platforms');
assert.match(unsupportedHost.stderr, /supports Linux and macOS on x64 or ARM64/u, 'T064-INSTALL-09 explains the unsupported host');

console.log('T064 package audit/release passed checksummed archive, installer integrity, existing-binary preservation and four Unix target probes');

function runAudit(args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync('bun', ['run', 'tools/package-audit.ts', ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
