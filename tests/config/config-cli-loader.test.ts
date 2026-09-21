import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/primitives/src/index';
import { loadStartupXiConfig, type StartupConfigFilesystemPort } from '../../packages/services/config/index';

const files = new Map<string, Uint8Array>([
  ['/tmp/xi-config/config.toml', new TextEncoder().encode('[editor]\nline-number = "relative"\n')],
  ['/tmp/xi-cli-config.toml', new TextEncoder().encode('[editor]\nline-number = "relative"\n')],
  ['/tmp/workspace/.helix/config.toml', new TextEncoder().encode('[editor]\nline-number = "relative"\n')],
]);
const filesystem: StartupConfigFilesystemPort = {
  readFile: async (path) => {
    const value = files.get(path);
    return value === undefined
      ? { ok: false as const, error: { code: 'not-found', message: `${path} not found`, retryable: false } }
      : { ok: true as const, value };
  },
};
const cancellation = new CancellationSource();
try {
  const loaded = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, '/tmp/xi-cli-config.toml');
  assert.deepEqual(loaded.diagnostics, [], 'T036-LOADING-CLI-01 an explicit config file loads without diagnostics');
  assert.equal(loaded.config?.editor.lineNumber, 'relative', 'T036-LOADING-CLI-02 explicit config reaches the compiled editor settings');
  assert.equal(loaded.config?.provenance['editor.line-number'], 'cli', 'T036-LOADING-CLI-03 explicit config is recorded as the CLI layer');

  const missing = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, '/tmp/missing-cli-config.toml');
  assert.equal(missing.config, undefined, 'T036-LOADING-CLI-04 missing explicit config does not silently fall back');
  assert.match(missing.diagnostics[0] ?? '', /missing-cli-config\.toml/u, 'T036-LOADING-CLI-05 missing explicit config reports its path');

  const user = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token);
  assert.deepEqual(user.diagnostics, [], 'T036-LOADING-USER-01 platform user config loads without diagnostics');
  assert.equal(user.config?.editor.lineNumber, 'relative', 'T036-LOADING-USER-02 ~/.config/xi/config.toml reaches the compiled editor settings');
  assert.equal(user.config?.provenance['editor.line-number'], 'user', 'T036-LOADING-USER-03 platform user config retains user-layer provenance');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor]\nline-number = "invalid"\n'));
  const invalidUser = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token);
  assert.equal(invalidUser.config, undefined, 'T036-LOADING-USER-04 invalid platform user config is rejected atomically');
  assert.match(invalidUser.diagnostics[0] ?? '', /line-number/u, 'T036-LOADING-USER-04 invalid platform user config reports its field');

  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor]\nline-number = "relative"\n'));
  const untrustedWorkspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml');
  assert.equal(untrustedWorkspace.config?.editor.lineNumber, 'relative', 'T036-LOADING-WORKSPACE-01 untrusted workspace config does not override the user layer');
  assert.notEqual(untrustedWorkspace.config?.provenance['editor.line-number'], 'workspace', 'T036-LOADING-WORKSPACE-01 untrusted workspace provenance is absent');
  assert.match(untrustedWorkspace.diagnostics[0] ?? '', /untrusted/u, 'T036-LOADING-WORKSPACE-02 prompted workspace trust is observable');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor.workspace-trust]\nlevel = "insecure"\n'));
  const workspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml');
  assert.deepEqual(workspace.diagnostics, [], 'T036-LOADING-WORKSPACE-03 explicitly trusted workspace config loads without diagnostics');
  assert.equal(workspace.config?.editor.lineNumber, 'relative', 'T036-LOADING-WORKSPACE-04 trusted workspace config reaches the compiled editor settings');
  assert.equal(workspace.config?.provenance['editor.line-number'], 'workspace', 'T036-LOADING-WORKSPACE-05 trusted workspace config is recorded as the workspace layer');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor.workspace-trust]\nlevel = "none"\nprompt = false\ntrusted = ["/tmp/*"]\n'));
  const patternedWorkspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml');
  assert.deepEqual(patternedWorkspace.diagnostics, [], 'T036-LOADING-WORKSPACE-06 trusted path pattern does not prompt');
  assert.equal(patternedWorkspace.config?.provenance['editor.line-number'], 'workspace', 'T036-LOADING-WORKSPACE-07 trusted path pattern loads the workspace layer');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor.workspace-trust]\nlevel = "none"\nprompt = false\n'));
  const silentUntrustedWorkspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml');
  assert.deepEqual(silentUntrustedWorkspace.diagnostics, [], 'T036-LOADING-WORKSPACE-08 prompt=false suppresses the trust diagnostic');
  assert.notEqual(silentUntrustedWorkspace.config?.provenance['editor.line-number'], 'workspace', 'T036-LOADING-WORKSPACE-09 prompt=false does not implicitly trust the workspace');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor.workspace-trust]\nlevel = "insecure"\n'));
  files.set('/tmp/workspace-invalid/.helix/config.toml', new TextEncoder().encode('[editor]\nline-number = "none"\n'));
  const invalidWorkspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace-invalid/.helix/config.toml');
  assert.equal(invalidWorkspace.config, undefined, 'T036-LOADING-WORKSPACE-10 invalid trusted workspace config is rejected atomically');
  assert.match(invalidWorkspace.diagnostics[0] ?? '', /line-number/u, 'T036-LOADING-WORKSPACE-10 invalid trusted workspace config reports its field');
  files.set('/tmp/xi-config/config.toml', new TextEncoder().encode('[editor]\neditor-config = false\n'));
  const disabledWorkspace = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml');
  assert.deepEqual(disabledWorkspace.diagnostics, [], 'T036-LOADING-EDITOR-CONFIG-01 disabled editor-config loads without diagnostics');
  assert.equal(disabledWorkspace.config?.editor.editorConfig, false, 'T036-LOADING-EDITOR-CONFIG-02 editor-config reaches the startup snapshot');
  assert.equal(disabledWorkspace.config?.editor.lineNumber, 'absolute', 'T036-LOADING-EDITOR-CONFIG-03 disabled editor-config skips the project layer');
  assert.equal(disabledWorkspace.config?.provenance['editor.line-number'], 'defaults', 'T036-LOADING-EDITOR-CONFIG-04 skipped project settings retain the default provenance');
  let disabledResolverCalls = 0;
  const disabledWithResolver = await loadStartupXiConfig(filesystem, '/tmp/xi-config', cancellation.token, [], undefined, undefined, '/tmp/workspace/.helix/config.toml', {}, {
    resolve: async () => {
      disabledResolverCalls += 1;
      return { workspaceConfigAllowed: false, serversAllowed: false, gitAllowed: false, stale: false };
    },
  });
  assert.equal(disabledResolverCalls, 1, 'T036-LOADING-EDITOR-CONFIG-05 workspace trust resolves even when local config loading is disabled');
  assert.equal(disabledWithResolver.config?.editor.editorConfig, false, 'T036-LOADING-EDITOR-CONFIG-06 trust resolution does not alter disabled editor-config');
} finally {
  cancellation.dispose();
}

console.log('T036 CLI config loader passed explicit-layer, provenance and missing-file checks.');
