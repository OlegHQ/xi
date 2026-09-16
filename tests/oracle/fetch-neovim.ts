#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { artifactRoot, readManifest, verifyOracleBundle } from './oracle-runner';

const manifest = await readManifest();
if (process.platform !== 'linux' || process.arch !== 'arm64') {
  throw new Error(`pinned-neovim-asset-unavailable: ${manifest.oracle.platform}; observed ${process.platform}-${process.arch}`);
}

await mkdir(artifactRoot, { recursive: true });
const archivePath = join(artifactRoot, manifest.oracle.asset.fileName);
const response = await fetch(manifest.oracle.asset.url, { redirect: 'follow' });
if (!response.ok) throw new Error(`neovim-download-failed: HTTP ${response.status} ${response.statusText}`);
const bytes = Buffer.from(await response.arrayBuffer());
const archiveHash = createHash('sha256').update(bytes).digest('hex');
if (archiveHash !== manifest.oracle.asset.sha256) {
  throw new Error(`neovim-archive-hash-mismatch: expected ${manifest.oracle.asset.sha256}, observed ${archiveHash}`);
}
await writeFile(archivePath, bytes);

const installRoot = resolve(artifactRoot, manifest.oracle.binaryPath, '..', '..');
await rm(installRoot, { recursive: true, force: true });
await run('tar', ['--extract', '--gzip', '--file', archivePath, '--directory', artifactRoot, '--no-same-owner']);
const installed = await verifyOracleBundle();
const actualBinaryHash = createHash('sha256').update(await readFile(installed.binaryPath)).digest('hex');
console.log(`oracle=${manifest.oracle.name} ${manifest.oracle.version}`);
console.log(`archive=${archivePath}`);
console.log(`archive_sha256=${archiveHash}`);
console.log(`binary=${installed.binaryPath}`);
console.log(`binary_sha256=${actualBinaryHash}`);
console.log(`runtime=${installed.runtimePath}`);
console.log(`runtime_docs_sha256=${manifest.oracle.runtimeDocs.sha256}`);

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd: resolve(artifactRoot, '../..'), stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`oracle-extract-failed: exit=${code}`));
    });
  });
}
