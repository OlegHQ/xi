#!/usr/bin/env bun
/**
 * Check the files that a release package must carry for the current target.
 *
 * This deliberately audits a concrete installation rather than treating
 * `bun build --compile` as proof that OpenTUI's native library was bundled.
 * The command is read-only; packaging jobs can use its output when writing a
 * release manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly optionalDependencies?: unknown;
}

interface NativeAsset {
  readonly packageName: string;
  readonly fileName: string;
}

interface AuditResult {
  readonly target: string;
  readonly openTuiVersion: string;
  readonly assets: readonly {
    readonly packageName: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly noticesPath: string;
}

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const requestedTarget = readOption('--target') ?? `${process.platform}-${process.arch}`;
const [targetPlatform, targetArch, ...targetSuffix] = requestedTarget.split('-');
if (targetPlatform === undefined || targetArch === undefined || targetSuffix.length > 1) {
  fail(`invalid target "${requestedTarget}" (expected <platform>-<arch>[ -musl])`);
}
const target = targetSuffix.length === 1 ? `${targetPlatform}-${targetArch}-${targetSuffix[0]}` : `${targetPlatform}-${targetArch}`;
const packageManifest = readManifest(join(root, 'package.json'));
const openTuiVersion = readDependencyVersion(packageManifest, '@opentui/core');
if (openTuiVersion === undefined) fail('package.json does not pin @opentui/core');

const assets = nativeAssets(targetPlatform, targetArch, targetSuffix[0]);
const foundAssets: AuditResult['assets'][number][] = [];
const optionalDependencyNames = readOptionalDependencies(join(root, 'node_modules', '@opentui', 'core', 'package.json'));
for (const asset of assets) {
  const packagePath = join(root, 'node_modules', '@opentui', asset.packageName);
  const packagePathManifest = join(packagePath, 'package.json');
  const nativePath = join(packagePath, asset.fileName);
  if (!existsSync(packagePathManifest) || !existsSync(nativePath) || !statSync(nativePath).isFile()) continue;
  const manifest = readManifest(packagePathManifest);
  if (manifest.version !== openTuiVersion) fail(`${asset.packageName} version does not match @opentui/core@${openTuiVersion}`);
  foundAssets.push({ packageName: asset.packageName, path: relativeToRoot(nativePath), sha256: sha256(nativePath) });
}

const noticesPath = join(root, 'docs', 'installation', 'THIRD-PARTY-NOTICES.md');
const nativeManifestPath = join(root, 'docs', 'installation', 'native-assets.sha256');
const notices = existsSync(noticesPath) ? readFileSync(noticesPath, 'utf8') : '';
const nativeManifest = existsSync(nativeManifestPath) ? readFileSync(nativeManifestPath, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (foundAssets.length === 0) fail(`no OpenTUI native asset found for ${target}`);
  if (!notices.includes('@opentui/core')) fail(`missing dependency notice: ${relativeToRoot(noticesPath)}`);
  for (const asset of foundAssets) {
    if (!nativeManifest.includes(`${asset.sha256}  ${asset.path}`)) {
      fail(`native asset checksum is absent or stale: ${asset.path}`);
    }
    if (!notices.includes(asset.packageName)) fail(`missing native package notice: ${asset.packageName}`);
  }
  if (!notices.includes('Grammar assets')) fail('third-party notices must state the grammar asset inventory');
  if (!notices.includes('Neovim')) fail('third-party notices must state the Neovim runtime policy');
  if (optionalDependencyNames.length === 0) fail('OpenTUI package has no optional native dependency metadata');
  const expectedPackageName = assets[0]?.packageName;
  if (expectedPackageName !== undefined && !optionalDependencyNames.includes(`@opentui/${expectedPackageName}`)) {
    fail(`OpenTUI package does not declare target optional dependency: @opentui/${expectedPackageName}`);
  }
}

const result: AuditResult = {
  target,
  openTuiVersion,
  assets: foundAssets,
  noticesPath: relativeToRoot(noticesPath),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function nativeAssets(platform: string, arch: string, libc: string | undefined): readonly NativeAsset[] {
  if (platform === 'linux') {
    const suffix = libc === 'musl' ? '-musl' : '';
    return [{ packageName: `core-linux-${arch}${suffix}`, fileName: 'libopentui.so' }];
  }
  if (platform === 'darwin') {
    return [{ packageName: `core-darwin-${arch}`, fileName: 'libopentui.dylib' }];
  }
  if (platform === 'win32') {
    return [{ packageName: `core-win32-${arch}`, fileName: 'libopentui.dll' }];
  }
  return [];
}

function readOption(name: string): string | undefined {
  const exact = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (exact !== undefined) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function readManifest(path: string): PackageManifest {
  if (!existsSync(path)) fail(`missing package manifest: ${relativeToRoot(path)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    fail(`invalid JSON manifest ${relativeToRoot(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`invalid object manifest: ${relativeToRoot(path)}`);
  return parsed as PackageManifest;
}

function readDependencyVersion(manifest: PackageManifest, name: string): string | undefined {
  const rootPackage = manifest as PackageManifest & { readonly dependencies?: unknown; readonly devDependencies?: unknown };
  for (const dependencies of [rootPackage.dependencies, rootPackage.devDependencies]) {
    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) continue;
    const version = (dependencies as Record<string, unknown>)[name];
    if (typeof version === 'string') return version;
  }
  return undefined;
}

function readOptionalDependencies(path: string): readonly string[] {
  const manifest = readManifest(path);
  if (typeof manifest.optionalDependencies !== 'object' || manifest.optionalDependencies === null || Array.isArray(manifest.optionalDependencies)) return [];
  return Object.keys(manifest.optionalDependencies as Record<string, unknown>);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function relativeToRoot(path: string): string {
  const absolute = resolve(path);
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

function fail(message: string): never {
  process.stderr.write(`package-audit: ${message}\n`);
  process.exit(1);
}
