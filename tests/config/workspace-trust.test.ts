import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CancellationSource } from '../../packages/primitives/src/entrypoints/launch';
import { NodeFilesystemPort } from '../../packages/platform/src/entrypoints/launch';
import { createWorkspaceTrustWiring } from '../../packages/services/src/entrypoints/config';

const root = await mkdtemp(join(tmpdir(), 'xi-workspace-trust-'));
const state = join(root, 'state');
const helix = join(root, '.helix');
const filesystem = new NodeFilesystemPort();
const cancellation = new CancellationSource();
const trust = createWorkspaceTrustWiring(filesystem, root, state, { HOME: root });
try {
  await mkdir(helix, { recursive: true });
  await writeFile(join(helix, 'config.toml'), '[editor]\nline-number = "relative"\n');

  const restricted = await trust.resolve(root, { level: 'servers', prompt: true, trusted: [] }, cancellation.token);
  assert.deepEqual(restricted, { workspaceConfigAllowed: false, serversAllowed: true, gitAllowed: false, stale: false }, 'WORKSPACE-TRUST-01 default servers level gates local config but keeps global servers');

  assert.equal(await trust.trust(), true, 'WORKSPACE-TRUST-02 explicit trust persists the workspace hash');
  const trusted = await trust.resolve(root, { level: 'none', prompt: false, trusted: [] }, cancellation.token);
  assert.deepEqual(trusted, { workspaceConfigAllowed: true, serversAllowed: true, gitAllowed: true, stale: false }, 'WORKSPACE-TRUST-03 a current explicit grant overrides level none');

  await writeFile(join(helix, 'config.toml'), '[editor]\nline-number = "relative"\n[editor.workspace-trust]\nprompt = false\n');
  const stale = await trust.resolve(root, { level: 'servers', prompt: true, trusted: [] }, cancellation.token);
  assert.deepEqual(stale, { workspaceConfigAllowed: false, serversAllowed: true, gitAllowed: false, stale: true }, 'WORKSPACE-TRUST-04 changed .helix content is stale and local config is withheld');

  assert.equal(await trust.exclude(), true, 'WORKSPACE-TRUST-05 exclusion persists');
  const excluded = await trust.resolve(root, { level: 'insecure', prompt: true, trusted: [] }, cancellation.token);
  assert.deepEqual(excluded, { workspaceConfigAllowed: false, serversAllowed: true, gitAllowed: true, stale: false }, 'WORKSPACE-TRUST-06 explicit exclusion overrides insecure local-config trust');

  await rm(join(helix, 'config.toml'));
  await writeFile(join(root, 'linked-config.toml'), '[editor]\nline-number = "relative"\n');
  await symlink(join(root, 'linked-config.toml'), join(helix, 'config.toml'));
  assert.equal(await trust.trust(), true, 'WORKSPACE-TRUST-07 explicit trust hashes symlinked Helix config');
  await writeFile(join(root, 'linked-config.toml'), '[editor]\nline-number = "absolute"\n');
  const staleSymlink = await trust.resolve(root, { level: 'servers', prompt: true, trusted: [] }, cancellation.token);
  assert.deepEqual(staleSymlink, { workspaceConfigAllowed: false, serversAllowed: true, gitAllowed: false, stale: true }, 'WORKSPACE-TRUST-08 changing a symlinked Helix config invalidates trust');
} finally {
  cancellation.dispose();
  await rm(root, { recursive: true, force: true });
}

console.log('Workspace trust persistence, stale detection and exclusion passed.');
