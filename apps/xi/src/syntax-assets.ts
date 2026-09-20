/**
 * Composition-root Tree-sitter asset loader. Grammar wasm/queries and the
 * runtime engine wasm are pinned vendor files, embedded into the compiled
 * binary via `bun build --compile`'s `type: "file"` import handling (the
 * same technique `@opentui/core` uses for its own bundled grammars -- see
 * vendor/opentui/packages/core/src/lib/tree-sitter/default-parser-assets.bun.ts).
 * Xi never imports OpenTUI's tree-sitter client; this file is UI-agnostic.
 *
 * File bytes are read through an injected reader (the composition root's own
 * `FilesystemPort`), not `node:fs` directly, so this file stays a plain `app`
 * module under the import-graph rules in tools/check-import-graph.ts. NOTE:
 * that checker has no allowance yet for the `type: "file"` embedded-asset
 * specifiers themselves (relative `node_modules` paths); see docs/evidence/T053.md.
 */
import type { CancellationToken, Result } from '../../../packages/primitives/src/entrypoints/launch';
import type { PlatformFailure } from '../../../packages/platform/src/entrypoints/launch';
import type {
  SyntaxGrammarFailure,
  SyntaxGrammarProvider,
  SyntaxGrammarSource,
  TreeSitterRuntimeOptions,
} from '../../../packages/services/src/entrypoints/syntax';

export interface AssetFileReader {
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
}

interface FileImportModule {
  readonly default: string;
}

interface GrammarAssetLoaders {
  readonly wasm: () => Promise<FileImportModule>;
  readonly highlights: () => Promise<FileImportModule>;
  /** Appended verbatim to the grammar's own highlights query. Later patterns win equal-range
   * ties in the syntax service's sweep, so this is how a vendored query's classification is
   * overridden without editing node_modules. */
  readonly extraHighlights?: string;
}

/** tree-sitter-json captures object keys as `@string.special.key` BEFORE its blanket
 * `(string) @string` rule, so the generic capture wins the tie and keys paint as plain
 * strings. Re-stating it last restores the distinct key color. */
const JSON_KEY_HIGHLIGHTS = '\n(pair key: (_) @string.special.key)\n';

const GRAMMAR_ASSET_LOADERS: Readonly<Record<string, GrammarAssetLoaders>> = {
  typescript: {
    wasm: () => import('../../../node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/@opentui/core/assets/typescript/highlights.scm' as string, { with: { type: 'file' } }),
  },
  javascript: {
    wasm: () => import('../../../node_modules/@opentui/core/assets/javascript/tree-sitter-javascript.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/@opentui/core/assets/javascript/highlights.scm' as string, { with: { type: 'file' } }),
  },
  python: {
    wasm: () => import('../../../node_modules/tree-sitter-python/tree-sitter-python.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/tree-sitter-python/queries/highlights.scm' as string, { with: { type: 'file' } }),
  },
  ruby: {
    wasm: () => import('../../../node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/tree-sitter-ruby/queries/highlights.scm' as string, { with: { type: 'file' } }),
  },
  json: {
    wasm: () => import('../../../node_modules/tree-sitter-json/tree-sitter-json.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/tree-sitter-json/queries/highlights.scm' as string, { with: { type: 'file' } }),
    extraHighlights: JSON_KEY_HIGHLIGHTS,
  },
  toml: {
    wasm: () => import('../../../node_modules/@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm' as string, { with: { type: 'file' } }),
  },
  // Block-level Markdown only: inline emphasis/links live in the separate `markdown_inline`
  // grammar, which needs query injections the syntax service does not implement yet.
  markdown: {
    wasm: () => import('../../../node_modules/@opentui/core/assets/markdown/tree-sitter-markdown.wasm' as string, { with: { type: 'file' } }),
    highlights: () => import('../../../node_modules/@opentui/core/assets/markdown/highlights.scm' as string, { with: { type: 'file' } }),
  },
};

/** The Tree-sitter engine's own runtime wasm (not a grammar), required by `Parser.init()`. */
async function loadRuntimeWasmModule(): Promise<FileImportModule> {
  return import('../../../node_modules/web-tree-sitter/tree-sitter.wasm' as string, { with: { type: 'file' } });
}

/**
 * Resolved lazily by the syntax service the first time a grammar is actually
 * needed, never at startup: this only touches the tree-sitter engine's own
 * runtime wasm (not a grammar), via the same embedded-file path OpenTUI's
 * bundled parser assets use inside a `bun build --compile` binary.
 */
export async function resolveTreeSitterRuntimeOptions(): Promise<TreeSitterRuntimeOptions> {
  const module = await loadRuntimeWasmModule();
  const path = module.default;
  return { locateFile: () => path };
}

const textDecoder = new TextDecoder('utf-8');

/** Lazily resolves and caches a bundled grammar per languageId; never loaded on the input path. */
export function createBundledGrammarProvider(reader: AssetFileReader, cancellation: CancellationToken): SyntaxGrammarProvider {
  const grammarCache = new Map<string, Promise<Result<SyntaxGrammarSource, SyntaxGrammarFailure>>>();

  async function loadGrammar(languageId: string): Promise<Result<SyntaxGrammarSource, SyntaxGrammarFailure>> {
    const loaders = GRAMMAR_ASSET_LOADERS[languageId];
    if (loaders === undefined) {
      return { ok: false, error: { kind: 'grammar-missing', message: `no bundled Tree-sitter grammar for languageId "${languageId}"` } };
    }
    try {
      const [wasmModule, highlightsModule] = await Promise.all([loaders.wasm(), loaders.highlights()]);
      const [wasmRead, highlightsRead] = await Promise.all([
        reader.readFile(wasmModule.default, cancellation),
        reader.readFile(highlightsModule.default, cancellation),
      ]);
      if (!wasmRead.ok) return { ok: false, error: { kind: 'grammar-missing', message: `failed to read grammar wasm for "${languageId}": ${wasmRead.error.message}` } };
      if (!highlightsRead.ok) return { ok: false, error: { kind: 'grammar-missing', message: `failed to read highlights query for "${languageId}": ${highlightsRead.error.message}` } };
      return { ok: true, value: { wasm: wasmRead.value, highlights: `${textDecoder.decode(highlightsRead.value)}${loaders.extraHighlights ?? ''}` } };
    } catch (error) {
      return {
        ok: false,
        error: { kind: 'grammar-missing', message: `failed to load Tree-sitter grammar for "${languageId}": ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }

  return {
    resolve(languageId: string): Promise<Result<SyntaxGrammarSource, SyntaxGrammarFailure>> {
      let pending = grammarCache.get(languageId);
      if (pending === undefined) {
        pending = loadGrammar(languageId);
        grammarCache.set(languageId, pending);
      }
      return pending;
    },
  };
}
