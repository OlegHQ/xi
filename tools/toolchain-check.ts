#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type ProbeFailure = string;

const packageJsonPath = resolve(process.cwd(), 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  devDependencies?: Record<string, string>;
};

const requireOpenTuiArtifact = process.env.XI_REQUIRE_OPEN_TUI_ARTIFACT === '1';
const requiredBunVersion = process.env.XI_REQUIRED_BUN_VERSION;
const requiredTypeScriptVersion = process.env.XI_REQUIRED_TYPESCRIPT_VERSION;

const expectedTypeScriptVersion = packageJson.devDependencies?.typescript ?? 'unknown';
const expectedOpenTuiVersion = packageJson.devDependencies?.['@opentui/core'] ?? 'unknown';

const run = (command: string, args: string[] = []): string => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (output.length === 0) {
    throw new Error(`No output from command: ${command} ${args.join(' ')}`);
  }
  return output;
};

const sha256 = (path: string): string => {
  const digest = createHash('sha256');
  const contents = readFileSync(path);
  digest.update(contents);
  return digest.digest('hex');
};

const openTuiArtifactOverride = process.env.XI_OPEN_TUI_ARTIFACT;
const openTuiArtifactCandidates = openTuiArtifactOverride === undefined
  ? getOpenTuiArtifactCandidates()
  : [resolve(openTuiArtifactOverride)];
const openTuiArtifact = openTuiArtifactCandidates.find((candidate) =>
  existsSync(candidate) && statSync(candidate).isFile()
);
const installedOpenTuiPackagePath = resolve(process.cwd(), 'node_modules', '@opentui', 'core', 'package.json');
const installedOpenTuiPackage = existsSync(installedOpenTuiPackagePath)
  ? parsePackageVersion(readFileSync(installedOpenTuiPackagePath, 'utf8'))
  : undefined;

const failures: ProbeFailure[] = [];

const bunVersion = run('bun', ['--version']);
console.log(`bun=${bunVersion}`);

const bunPath = run('which', ['bun']);
console.log(`bun_path=${bunPath}`);
console.log(`bun_sha256=${sha256(bunPath)}`);

const tscVersion = run('bun', ['x', 'tsc', '--version']);
console.log(`typescript_runtime=${tscVersion}`);
console.log(`typescript_expected=${expectedTypeScriptVersion}`);

console.log(`typescript_pinned=${expectedTypeScriptVersion}`);
console.log(`platform=${process.platform}`);
console.log(`arch=${process.arch}`);

console.log(`open_tui_expected=${expectedOpenTuiVersion}`);
console.log(`open_tui_installed=${installedOpenTuiPackage ?? 'missing'}`);
if (installedOpenTuiPackage !== undefined && installedOpenTuiPackage !== expectedOpenTuiVersion) {
  failures.push(`open-tui-version-mismatch: expected ${expectedOpenTuiVersion}, observed ${installedOpenTuiPackage}`);
}

let openTuiRuntimeLoaded = false;
try {
  const openTui = await import('@opentui/core');
  openTui.resolveRenderLib().getBuildOptions();
  openTuiRuntimeLoaded = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`open_tui_runtime=unavailable: ${message}`);
}
console.log(`open_tui_runtime=${openTuiRuntimeLoaded ? 'loaded' : 'unavailable'}`);

if (openTuiArtifact) {
  console.log(`open_tui_native_artifact=${openTuiArtifact}`);
  console.log(`open_tui_native_artifact_sha256=${sha256(openTuiArtifact)}`);
} else {
  console.log('open_tui_native_artifact=missing');
}

if (requiredBunVersion && requiredBunVersion !== bunVersion) {
  failures.push(`required-bun-version-mismatch: expected ${requiredBunVersion}, observed ${bunVersion}`);
}
if (requiredTypeScriptVersion && requiredTypeScriptVersion !== tscVersion.replace(/^Version /, '').trim()) {
  failures.push(`required-typescript-version-mismatch: expected ${requiredTypeScriptVersion}, observed ${tscVersion}`);
}
if (expectedOpenTuiVersion !== 'unknown' && !openTuiRuntimeLoaded) {
  failures.push('pinned-open-tui-runtime-unavailable');
}
if (requiredOpenTuiArtifact() && (!openTuiArtifact || !openTuiRuntimeLoaded)) {
  failures.push('required-open-tui-native-artifact-missing-or-unloadable');
}

if (failures.length > 0) {
  console.error('Toolchain check failed');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log('Toolchain probe complete');
process.exit(0);

function requiredOpenTuiArtifact(): boolean {
  return (
    requireOpenTuiArtifact ||
    process.argv.includes('--require-open-tui') ||
    process.argv.includes('--require-opentui')
  );
}

function getOpenTuiArtifactCandidates(): string[] {
  const packageRoot = resolve(process.cwd(), 'node_modules', '@opentui');
  if (process.platform === 'linux') {
    const fileName = 'libopentui.so';
    const packageNames = [
      `core-linux-${process.arch}`,
      `core-linux-${process.arch}-musl`,
    ];
    return packageNames.map((packageName) => resolve(packageRoot, packageName, fileName));
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    const fileName = process.platform === 'darwin' ? 'libopentui.dylib' : 'libopentui.dll';
    return [resolve(packageRoot, `core-${process.platform}-${process.arch}`, fileName)];
  }

  return [];
}

function parsePackageVersion(source: string): string | undefined {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    return undefined;
  }
  return typeof parsed.version === 'string' ? parsed.version : undefined;
}
