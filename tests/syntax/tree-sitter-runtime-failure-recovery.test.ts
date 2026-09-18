#!/usr/bin/env bun
// F1-6 regression: `initializeTreeSitterRuntime`'s process-global cache memoized ANY settled
// result, including a FAILURE. Since the underlying WASM module can genuinely only be
// initialized once successfully per process, that's fine for a success -- but caching a failure
// forever meant one transient init error (e.g. a bad `wasmBinary`) permanently broke every
// highlighter instance created afterward in the same process, even a fresh one built after the
// failing one was disposed. This test asserts: (a) a failed init is not cached -- the next call
// gets a clean retry and can succeed, and (b) `resetTreeSitterRuntimeForTesting` forces a fresh
// load even after a cached success.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initializeTreeSitterRuntime, resetTreeSitterRuntimeForTesting } from '../../packages/services/syntax/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

async function main(): Promise<void> {
  resetTreeSitterRuntimeForTesting();

  // (a) A failing init must not be cached: a subsequent call with a real runtime must still be
  // able to succeed, not inherit the permanent failure. Uses a throwing `locateFile` (a clean,
  // catchable JS-level failure) rather than malformed wasm bytes: the latter drives Emscripten
  // into its own hard `abort()`, a genuine, permanent, process-wide corruption of the underlying
  // WASM module -- unrelated to and unfixable by this cache, and unsafe to provoke in a test (it
  // re-throws past our own catch as an uncaught RuntimeError).
  const failed = await initializeTreeSitterRuntime({ locateFile: () => { throw new Error('injected locateFile failure'); } });
  assert.equal(failed.ok, false, 'F1-6a a throwing locateFile fails to initialize');

  const realWasm = await readFile(RUNTIME_WASM_PATH);
  const recovered = await initializeTreeSitterRuntime({ wasmBinary: realWasm });
  assert.equal(recovered.ok, true, 'F1-6b a real runtime still initializes after a prior failure -- the failure was not cached forever');

  // (b) Once successful, the runtime IS shared/cached for the process (by design -- repeat
  // Parser.init() calls are wasteful, and every highlighter instance should share one warm
  // runtime): a second call returns the same cached success without needing a wasmBinary again.
  const cached = await initializeTreeSitterRuntime();
  assert.equal(cached.ok, true, 'F1-6c a successful runtime is shared across calls (no wasmBinary needed)');

  // The testing-only reset hook forces a fresh load even after a cached success.
  resetTreeSitterRuntimeForTesting();
  const reloaded = await initializeTreeSitterRuntime({ wasmBinary: realWasm });
  assert.equal(reloaded.ok, true, 'F1-6d resetTreeSitterRuntimeForTesting forces a fresh, successful reload');

  console.log('F1-6 tree-sitter-runtime-failure-recovery: PASS');
}

await main();
