#!/usr/bin/env bun
/** Build a self-contained Xi release staging directory for the current target. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, cpSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface PackageAuditOutput {
  readonly target: string;
  readonly openTuiVersion: string;
  readonly assets: readonly {
    readonly packageName: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly noticesPath: string;
}

interface RootPackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const output = resolve(readOption('--output') ?? join(root, 'dist', `xi-${process.platform}-${process.arch}`));
const packageJson = readObject(join(root, 'package.json')) as RootPackageJson;
const product = typeof packageJson.name === 'string' ? packageJson.name : undefined;
const version = typeof packageJson.version === 'string' ? packageJson.version : undefined;
if (product !== 'xi' || version === undefined) fail('package.json must define xi name and version');

const audit = runAudit();
if (audit.assets.length === 0) fail(`no OpenTUI native asset was found for ${audit.target}`);
if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'].includes(audit.target)) {
  fail(`unsupported release target: ${audit.target}`);
}

mkdirSync(output, { recursive: true });
const executableName = process.platform === 'win32' ? 'xi.exe' : 'xi';
const executable = join(output, executableName);
const build = spawnSync('bun', ['run', 'tools/package-build.ts', executable], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (build.status !== 0) fail(`bun compile failed: ${build.stdout ?? ''}${build.stderr ?? ''}`);

const noticesSource = join(root, 'docs', 'installation', 'THIRD-PARTY-NOTICES.md');
const checksumSource = join(root, 'docs', 'installation', 'native-assets.sha256');
cpSync(noticesSource, join(output, 'THIRD-PARTY-NOTICES.md'));
cpSync(checksumSource, join(output, 'native-assets.sha256'));
copyDependencyLicenses(output, audit);

const binaryHash = sha256(executable);
const manifest = {
  schemaVersion: 1,
  product,
  version,
  target: audit.target,
  executable: executableName,
  binarySha256: binaryHash,
  openTui: {
    version: audit.openTuiVersion,
    nativeAssets: audit.assets,
  },
  notices: 'THIRD-PARTY-NOTICES.md',
  nativeChecksums: 'native-assets.sha256',
  licensesDirectory: 'licenses',
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const releaseDirectory = resolve(readOption('--release-directory') ?? join(output, '..'));
mkdirSync(releaseDirectory, { recursive: true });
const archiveName = `xi-${version}-${audit.target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
const archivePath = join(releaseDirectory, archiveName);
const archive = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
  join(root, 'tools', 'package-archive.py'), output, archivePath,
], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (archive.status !== 0) fail(`archive creation failed: ${archive.error?.message ?? archive.stderr ?? ''}`);
const sumsPath = join(releaseDirectory, 'SHA256SUMS');
const installerPath = join(releaseDirectory, 'install.sh');
cpSync(join(root, 'docs', 'installation', 'install.sh'), installerPath);
const powershellInstallerPath = join(releaseDirectory, 'install.ps1');
cpSync(join(root, 'docs', 'installation', 'install.ps1'), powershellInstallerPath);
writeFileSync(sumsPath, `${sha256(archivePath)}  ${archiveName}\n${sha256(installerPath)}  install.sh\n${sha256(powershellInstallerPath)}  install.ps1\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ output, archivePath, checksumsPath: sumsPath, manifest }, null, 2)}\n`);

function runAudit(): PackageAuditOutput {
  const result = spawnSync('bun', ['run', 'tools/package-audit.ts', '--check'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail(`package audit failed: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  const raw: unknown = JSON.parse(result.stdout ?? '');
  if (!isPackageAuditOutput(raw)) fail('package audit returned an invalid result');
  return raw;
}

function copyDependencyLicenses(outputDirectory: string, audit: PackageAuditOutput): void {
  const licensesDirectory = join(outputDirectory, 'licenses');
  mkdirSync(licensesDirectory, { recursive: true });
  const packageNames = [
    '@opentui/core',
    '@opentui/solid',
    'solid-js',
    ...audit.assets.map((asset) => `@opentui/${asset.packageName}`),
    'bun-ffi-structs',
    'diff',
    'marked',
    'string-width',
    'strip-ansi',
    'ansi-regex',
    'emoji-regex',
    'get-east-asian-width',
    'vscode-jsonrpc',
    'vscode-languageserver-protocol',
    'vscode-languageserver-types',
    'web-tree-sitter',
    'undici-types',
  ];
  for (const packageName of packageNames) {
    const packageDirectory = join(root, 'node_modules', ...packageName.split('/'));
    const manifestPath = join(packageDirectory, 'package.json');
    if (!existsSync(manifestPath)) fail(`license source package is missing: ${packageName}`);
    const manifest = readObject(manifestPath);
    const licenseFiles = findLicenseFiles(packageDirectory);
    if (licenseFiles.length === 0) fail(`license file is missing: ${packageName}`);
    const destination = join(licensesDirectory, packageName.replaceAll('/', '__'));
    mkdirSync(destination, { recursive: true });
    for (const source of licenseFiles) cpSync(source, join(destination, source.slice(packageDirectory.length + 1)));
    const packageLicense = manifest.license;
    writeFileSync(join(destination, 'PACKAGE.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, license: packageLicense }, null, 2)}\n`, 'utf8');
  }
}

function findLicenseFiles(directory: string): readonly string[] {
  const candidates = ['LICENSE', 'LICENSE.md', 'License.txt', 'license', 'LICENSE-MIT.txt', 'LICENSE-GHOSTTY', 'LICENSE-LCMS2', 'LICENSE-LIBWEBP', 'LICENSE-STB', 'LICENSE-WUFFS'];
  return candidates.map((name) => join(directory, name)).filter((path) => existsSync(path));
}

function readObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    fail(`invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`expected object JSON at ${path}`);
  return parsed as Record<string, unknown>;
}

function isPackageAuditOutput(value: unknown): value is PackageAuditOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.target !== 'string' || typeof candidate.openTuiVersion !== 'string' || !Array.isArray(candidate.assets)) return false;
  return candidate.assets.every((asset: unknown) => {
    if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) return false;
    const item = asset as Record<string, unknown>;
    return typeof item.packageName === 'string' && typeof item.path === 'string' && typeof item.sha256 === 'string';
  });
}

function readOption(name: string): string | undefined {
  const exact = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (exact !== undefined) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message: string): never {
  process.stderr.write(`package-release: ${message}\n`);
  process.exit(1);
}
