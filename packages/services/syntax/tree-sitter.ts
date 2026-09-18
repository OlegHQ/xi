/**
 * The Tree-sitter binding is deliberately loaded on demand.  Loading a WASM
 * grammar can take long enough to be observable while typing, so the syntax
 * service never performs this work from its request path.
 */

import type { Language, Parser, Query } from 'web-tree-sitter';
import type { Result } from '../../contracts/src/index';

export const TREE_SITTER_RUNTIME_VERSION = '0.25.10' as const;

export type TreeSitterFailure =
  | { readonly kind: 'parser-crash'; readonly message: string }
  | { readonly kind: 'grammar-missing'; readonly message: string };

export interface TreeSitterRuntime {
  readonly version: typeof TREE_SITTER_RUNTIME_VERSION;
  readonly Parser: typeof Parser;
  readonly Language: typeof Language;
  readonly Query: typeof Query;
}

export interface LoadedTreeSitterGrammar {
  readonly runtime: TreeSitterRuntime;
  readonly language: Language;
  readonly name: string | null;
  readonly abiVersion: number;
}

export interface TreeSitterRuntimeOptions {
  /** Embedded runtime wasm bytes, required inside a `bun build --compile` binary. */
  readonly wasmBinary?: Uint8Array;
  /** Emscripten module file locator, used when the wasm is not passed inline. */
  readonly locateFile?: (name: string) => string;
}

// The underlying web-tree-sitter WASM module can only be initialized once per process (repeat
// `Parser.init()` calls are wasteful at best), so a process-global cache is the right shape for
// the *successful* case: every owning highlighter instance should share one warm runtime rather
// than each re-loading the WASM binary. What must not be process-global is a *failed* init: F1-6
// found that a transient failure (e.g. one bad `options.wasmBinary`) was cached forever, so every
// highlighter instance created afterward -- including a fresh one after the failing instance was
// disposed -- stayed permanently broken with no way to recover. Only successes are memoized here;
// a failure is never cached, so the next caller (or the next `openDocument` after a disposed
// tracker is replaced) gets a clean retry.
let runtimePromise: Promise<Result<TreeSitterRuntime, TreeSitterFailure>> | undefined;

/** Initialize the pinned binding. This function is never called by submit(). */
export function initializeTreeSitterRuntime(
  options?: TreeSitterRuntimeOptions,
): Promise<Result<TreeSitterRuntime, TreeSitterFailure>> {
  if (runtimePromise !== undefined) return runtimePromise;
  const attempt = import('web-tree-sitter').then(async (module) => {
    try {
      await module.Parser.init(options === undefined ? undefined : {
        ...(options.wasmBinary === undefined ? {} : { wasmBinary: options.wasmBinary }),
        ...(options.locateFile === undefined ? {} : { locateFile: options.locateFile }),
      });
      return {
        ok: true,
        value: {
          version: TREE_SITTER_RUNTIME_VERSION,
          Parser: module.Parser,
          Language: module.Language,
          Query: module.Query,
        },
      } as const;
    } catch {
      return {
        ok: false,
        error: { kind: 'parser-crash', message: 'Tree-sitter WASM runtime failed to initialize' },
      } as const;
    }
  }).catch(() => ({
    ok: false,
    error: { kind: 'parser-crash', message: 'Tree-sitter runtime could not be loaded' },
  } as const));
  const wrapped: Promise<Result<TreeSitterRuntime, TreeSitterFailure>> = attempt.then((result) => {
    // Compare against `wrapped` (this call's own cache entry), not `attempt` (a different,
    // inner promise object `wrapped` derives from) -- comparing against `attempt` here always
    // failed and silently defeated the whole "don't cache a failure" fix.
    if (!result.ok && runtimePromise === wrapped) runtimePromise = undefined;
    return result;
  });
  runtimePromise = wrapped;
  return wrapped;
}

/** Test-only: forces the next `initializeTreeSitterRuntime` call to load again, even after a
 * success was cached. Production code never needs this -- a successful runtime is safe to share
 * across every highlighter instance for the life of the process. */
export function resetTreeSitterRuntimeForTesting(): void {
  runtimePromise = undefined;
}

/**
 * Load a caller-provided, hash-pinned grammar. Grammar loading is explicit and
 * asynchronous; a missing grammar is a typed fallback condition for callers.
 */
export async function loadTreeSitterGrammar(
  source: string | Uint8Array,
): Promise<Result<LoadedTreeSitterGrammar, TreeSitterFailure>> {
  const runtime = await initializeTreeSitterRuntime();
  if (!runtime.ok) return runtime;
  try {
    const language = await runtime.value.Language.load(source);
    return {
      ok: true,
      value: {
        runtime: runtime.value,
        language,
        name: language.name,
        abiVersion: language.abiVersion,
      },
    };
  } catch {
    return {
      ok: false,
      error: { kind: 'grammar-missing', message: 'Tree-sitter grammar could not be loaded' },
    };
  }
}
