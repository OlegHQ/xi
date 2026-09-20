#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

export interface SourceUnit {
  readonly path: string;
  readonly text: string;
}

const allOwners = ['app', 'ui', 'workbench', 'services', 'platform', 'vim', 'document', 'selections', 'layout', 'contracts', 'primitives'] as const;
type Owner = (typeof allOwners)[number];

const allowedEdges: Readonly<Record<Owner, ReadonlySet<Owner>>> = {
  app: new Set(['ui', 'workbench', 'services', 'platform', 'vim', 'document', 'selections', 'layout', 'contracts', 'primitives']),
  ui: new Set(['workbench', 'contracts', 'layout']),
  workbench: new Set(['vim', 'document', 'selections', 'contracts']),
  services: new Set(['contracts', 'document']),
  platform: new Set(['contracts', 'primitives']),
  vim: new Set(['document', 'selections', 'contracts', 'layout']),
  document: new Set(['primitives']),
  selections: new Set(['document', 'primitives']),
  layout: new Set(['document', 'selections']),
  contracts: new Set(['primitives']),
  primitives: new Set(),
};

const knownPackages = new Set<Owner>(allOwners.filter((owner) => owner !== 'app'));
const forbiddenNodeModules = new Set([
  'assert', 'child_process', 'crypto', 'events', 'fs', 'os', 'path', 'process', 'stream', 'timers', 'tty', 'url', 'util', 'worker_threads',
]);
const ownerExternalDependencies: Readonly<Partial<Record<Owner, ReadonlySet<string>>>> = {
  ui: new Set(['@opentui/core', 'solid-js']),
  services: new Set(['vscode-jsonrpc', 'vscode-languageserver-protocol', 'web-tree-sitter']),
};

export function collectPackageSources(repositoryRoot: string): SourceUnit[] {
  const units: SourceUnit[] = [];
  for (const root of ['apps/xi', 'packages']) {
    const absolute = resolve(repositoryRoot, root);
    if (existsSync(absolute)) collect(absolute);
  }
  return units;

  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.bun-temp' || entry.name === '.artifacts') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(absolute);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        units.push({
          path: relative(repositoryRoot, absolute).split(sep).join('/'),
          text: readFileSync(absolute, 'utf8'),
        });
      }
    }
  }
}

export function analyzePackageSources(units: readonly SourceUnit[]): string[] {
  const byPath = new Map(units.map((unit) => [normalizeSourcePath(unit.path), unit]));
  const failures: string[] = [];
  const fileEdges = new Map<string, Set<string>>([...byPath.keys()].map((path) => [path, new Set<string>()]));

  for (const unit of units) {
    const sourceOwner = ownerOf(unit.path);
    if (sourceOwner === undefined) continue;
    for (const imported of importedSpecifiers(unit.text, unit.path)) {
      const targetOwner = ownerOfSpecifier(imported.specifier, unit.path, byPath);
      if (targetOwner === undefined) {
        const externalFailure = validateExternal(sourceOwner, imported.specifier, unit.path);
        if (externalFailure !== undefined) failures.push(externalFailure);
        continue;
      }
      const normalizedImporter = normalizeSourcePath(unit.path);
      const targetPath = resolveRelativeTarget(unit.path, imported.specifier, byPath);
      if (targetPath !== undefined) fileEdges.get(normalizedImporter)?.add(normalizeSourcePath(targetPath));
      if (sourceOwner !== targetOwner && !allowedEdges[sourceOwner].has(targetOwner)) {
        failures.push(`${imported.location}: forbidden dependency ${sourceOwner} -> ${targetOwner} (${imported.specifier})`);
      }
      if (targetOwner !== sourceOwner) {
        if (targetPath !== undefined && !isPublicEntryPoint(targetPath, targetOwner)) {
          failures.push(`${imported.location}: deep cross-owner import into ${targetOwner} (${targetPath})`);
        }
        if (sourceOwner === 'app' && targetPath !== undefined
          && !normalizeSourcePath(targetPath).startsWith(`packages/${targetOwner}/src/entrypoints/`)) {
          failures.push(`${imported.location}: apps/xi must import ${targetOwner} via a packages/${targetOwner}/src/entrypoints/ path (${targetPath})`);
        }
      } else if (sourceOwner === 'services' && targetPath !== undefined) {
        const sourceFeature = servicesFeatureOf(unit.path);
        const targetFeature = servicesFeatureOf(targetPath);
        if (sourceFeature !== undefined && targetFeature !== undefined && sourceFeature !== targetFeature
          && normalizeSourcePath(targetPath) !== `packages/services/${targetFeature}/index.ts`) {
          failures.push(`${imported.location}: deep cross-feature import into services/${targetFeature} (${targetPath}); import via packages/services/${targetFeature}/index.ts`);
        }
      }
    }
  }

  failures.push(...findCycles(fileEdges));
  return failures;
}

// H2-7: static rules beyond the owner DAG above, wired into the same `checkImportGraph()` that
// `bun run check:public-boundary` already runs. Each function below must FAIL today wherever a
// real violation exists (never weaken the rule to make it pass) -- callers report the returned
// list rather than treating an empty allowlist as "add the violating file to the allowlist".

/**
 * (a) Services may only see a read-only document surface. `openTextDocument`/
 * `TextFileDocument`/`applyBatch` are the mutating/constructing document APIs
 * (docs/architecture.md: "Services never mutate buffers directly"); importing any of
 * them as a *value* (not `import type`) from `packages/services/**` is forbidden except through
 * this explicit allowlist, which must end empty once every violation is fixed.
 */
const SERVICES_DOCUMENT_SURFACE_ALLOWLIST: ReadonlySet<string> = new Set([]);
const FORBIDDEN_SERVICES_DOCUMENT_IMPORTS = ['openTextDocument', 'TextFileDocument', 'applyBatch'];

function checkServicesDocumentSurface(units: readonly SourceUnit[]): string[] {
  const failures: string[] = [];
  for (const unit of units) {
    const normalized = normalizeSourcePath(unit.path);
    if (!normalized.startsWith('packages/services/')) continue;
    if (SERVICES_DOCUMENT_SURFACE_ALLOWLIST.has(normalized)) continue;
    for (const match of unit.text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gu)) {
      if (match[1] !== undefined) continue; // `import type { ... }`: erased at runtime, not a value import.
      const names = (match[2] ?? '').split(',').map((entry) => entry.trim().split(/\s+as\s+/u)[0]?.trim()).filter((name): name is string => !!name);
      for (const forbidden of FORBIDDEN_SERVICES_DOCUMENT_IMPORTS) {
        if (names.includes(forbidden)) {
          const line = unit.text.slice(0, match.index ?? 0).split('\n').length;
          failures.push(`${unit.path}:${line}: ARCH-SERVICES-DOCUMENT-SURFACE-01 packages/services/** may not import ${forbidden} as a value (read-only document surface only)`);
        }
      }
    }
  }
  return failures;
}

/** True when the token at `openBraceIndex` (a `{`) opens a function/method/arrow body rather
 * than a control-flow block (`if`/`for`/`while`/`switch`/`catch`/`with`) or a plain object
 * literal. Used by both (b) (apps/xi function length) and (d) (module-level segmenter).
 * Walks back past an optional `: ReturnType` annotation to find the parameter list's closing
 * `)` -- a return type that is itself an inline object-literal type (`(): { a: number } {`)
 * defeats this heuristic (rare enough in this codebase to accept as a known gap). */
function isFunctionBodyOpenBrace(tokens: readonly LexToken[], openBraceIndex: number): boolean {
  let index = openBraceIndex - 1;
  while (index >= 0) {
    const token = tokens[index];
    if (token === undefined) return false;
    if (token.text === '=>') return true;
    if (token.text === ')') break;
    if (token.text === ';' || token.text === '{' || token.text === '}') return false;
    index -= 1;
  }
  if (index < 0) return false;
  let depth = 0;
  for (; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.text === ')') depth += 1;
    else if (token.text === '(') {
      depth -= 1;
      if (depth === 0) {
        const beforeParen = tokens[index - 1];
        if (beforeParen === undefined) return false;
        return !['if', 'for', 'while', 'switch', 'catch', 'with'].includes(beforeParen.text);
      }
    }
  }
  return false;
}

interface FunctionBodyRange { readonly openIndex: number; readonly closeIndex: number; readonly startLine: number; readonly endLine: number; }

/** Every function/method/arrow body in `tokens`, including nested ones, as token-index and
 * source-line ranges. */
function functionBodyRanges(tokens: readonly LexToken[]): FunctionBodyRange[] {
  const ranges: FunctionBodyRange[] = [];
  const openStack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.text === '{') {
      openStack.push(isFunctionBodyOpenBrace(tokens, index) ? index : -1);
    } else if (token.text === '}') {
      const openIndex = openStack.pop();
      if (openIndex !== undefined && openIndex >= 0) {
        const openToken = tokens[openIndex];
        if (openToken !== undefined) ranges.push({ openIndex, closeIndex: index, startLine: openToken.line, endLine: token.line });
      }
    }
  }
  return ranges;
}

/** (b) apps/xi may not define a function/method/arrow body longer than this many source lines
 * -- ARCH-COMPOSITION-ROOT-01's "small, reviewable wiring" intent, enforced mechanically
 * instead of left to review. (apps/xi importing packages/vim internals beyond its entrypoints
 * is already caught by the generic deep-cross-owner-import rule above.) */
const MAX_APP_FUNCTION_LINES = 150;

function checkAppFunctionLength(units: readonly SourceUnit[]): string[] {
  const failures: string[] = [];
  for (const unit of units) {
    if (!normalizeSourcePath(unit.path).startsWith('apps/xi/')) continue;
    const tokens = lexSource(unit.text);
    for (const range of functionBodyRanges(tokens)) {
      const length = range.endLine - range.startLine + 1;
      if (length > MAX_APP_FUNCTION_LINES) {
        failures.push(`${unit.path}:${range.startLine}: ARCH-APP-FUNCTION-LENGTH-01 function body spans ${length} lines (max ${MAX_APP_FUNCTION_LINES})`);
      }
    }
  }
  return failures;
}

/** (c) `packages/ui` render callbacks (`renderSelf`) must stay read-only: OpenTUI is confined
 * to rendering, never mutating workbench state from inside a paint callback
 * (docs/architecture.md: "UI never implements motion/range/edit semantics"). This
 * flags calls that reach a workbench/session/host port -- `this.#workbench.foo(`,
 * `workbench.foo(`, `session.foo(`, `.setViewScroll(`, `.applyXxx(`, `.dispatch(`,
 * `.commit(`, or an `on<X>Change?.(` callback invocation -- but not an OpenTUI render-context
 * call like `this.ctx.setCursorPosition(` or `buffer.setCell(`, which never touch workbench
 * state and are how a render callback is expected to paint. */
function checkUiRenderSelfIsReadOnly(units: readonly SourceUnit[]): string[] {
  const failures: string[] = [];
  const setterCall =
    /(?:this\.#workbench\.|this\.#session\.|this\.#host\.|this\.workbench\.|this\.session\.|this\.host\.|(?<![.\w])workbench\.|(?<![.\w])session\.|(?<![.\w])host\.)(?:set|apply|dispatch|commit)\w*\s*\(|\.setViewScroll\s*\(|\.dispatch\s*\(|\.commit\s*\(|\bon[A-Z]\w*Change\??\.\s*\(/u;
  for (const unit of units) {
    const normalized = normalizeSourcePath(unit.path);
    if (!normalized.startsWith('packages/ui/')) continue;
    const tokens = lexSource(unit.text);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token?.kind !== 'identifier' || token.text !== 'renderSelf') continue;
      const openBrace = tokens.slice(index).findIndex((candidate) => candidate.text === '{');
      if (openBrace < 0) continue;
      const openIndex = index + openBrace;
      const range = functionBodyRanges(tokens).find((candidate) => candidate.openIndex === openIndex);
      if (range === undefined) continue;
      const bodyLines = unit.text.split('\n').slice(range.startLine - 1, range.endLine);
      for (let lineOffset = 0; lineOffset < bodyLines.length; lineOffset += 1) {
        const lineText = bodyLines[lineOffset] ?? '';
        if (setterCall.test(lineText)) {
          failures.push(`${unit.path}:${range.startLine + lineOffset}: ARCH-UI-RENDER-READONLY-01 renderSelf body calls a workbench setter (${lineText.trim()})`);
        }
      }
    }
  }
  return failures;
}

/** (d) `new Intl.Segmenter(...)`/`new GRAPHEME_SEGMENTER(...)` must be a module-level `const`,
 * never constructed inside a function body -- docs/performance.md's keystroke
 * budget cannot afford re-allocating a segmenter per keystroke/render. */
function checkModuleLevelSegmenterConstruction(units: readonly SourceUnit[]): string[] {
  const failures: string[] = [];
  for (const unit of units) {
    if (!normalizeSourcePath(unit.path).startsWith('packages/')) continue;
    const tokens = lexSource(unit.text);
    const ranges = functionBodyRanges(tokens);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token?.text !== 'new') continue;
      const next = tokens[index + 1];
      const isIntlSegmenter = next?.text === 'Intl' && tokens[index + 2]?.text === '.' && tokens[index + 3]?.text === 'Segmenter' && tokens[index + 4]?.text === '(';
      const isGraphemeSegmenter = next?.text === 'GRAPHEME_SEGMENTER' && tokens[index + 2]?.text === '(';
      if (!isIntlSegmenter && !isGraphemeSegmenter) continue;
      const insideFunction = ranges.some((range) => index > range.openIndex && index < range.closeIndex);
      if (insideFunction) {
        failures.push(`${unit.path}:${token.line}: ARCH-MODULE-LEVEL-SEGMENTER-01 segmenter constructed inside a function body (must be a module-level const)`);
      }
    }
  }
  return failures;
}

export function checkStaticRules(units: readonly SourceUnit[]): string[] {
  return [
    ...checkServicesDocumentSurface(units),
    ...checkAppFunctionLength(units),
    ...checkUiRenderSelfIsReadOnly(units),
    ...checkModuleLevelSegmenterConstruction(units),
  ];
}

/** CI's negative fixtures prove the checker rejects a reverse import and a cycle. */
export function checkImportGraph(repositoryRoot: string): string[] {
  const sourceUnits = collectPackageSources(repositoryRoot);
  const failures = analyzePackageSources(sourceUnits);
  failures.push(...checkStaticRules(sourceUnits));
  const reverseImport = analyzePackageSources([
    { path: 'packages/vim/src/index.ts', text: "import type {} from '../../ui/src/index.ts';\n" },
    { path: 'packages/ui/src/index.ts', text: 'export {};\n' },
  ]);
  if (!reverseImport.some((failure) => failure.includes('forbidden dependency vim -> ui'))) {
    failures.push('ARCH-UI-IMPORT-01: graph checker accepted a forbidden Vim-to-UI import');
  }

  const cycle = analyzePackageSources([
    { path: 'packages/workbench/src/index.ts', text: "import type {} from '../../vim/src/index.ts';\n" },
    { path: 'packages/vim/src/index.ts', text: "import type {} from '../../workbench/src/index.ts';\n" },
  ]);
  if (!cycle.some((failure) => failure.includes('import cycle'))) {
    failures.push('ARCH-CYCLE-01: graph checker accepted a cyclic owner graph');
  }

  const serviceCycle = analyzePackageSources([
    { path: 'packages/services/src/index.ts', text: "import type {} from './files/index.ts';\n" },
    { path: 'packages/services/src/files/index.ts', text: "import type {} from '../index.ts';\n" },
  ]);
  if (!serviceCycle.some((failure) => failure.includes('import cycle'))) {
    failures.push('ARCH-SERVICE-CYCLE-01: graph checker accepted circular service modules');
  }

  const deepAlias = analyzePackageSources([
    { path: 'apps/xi/src/index.ts', text: "import type {} from '@xi/vim/private';\n" },
    { path: 'packages/vim/src/index.ts', text: 'export {};\n' },
  ]);
  if (!deepAlias.some((failure) => failure.includes('deep cross-owner import into vim'))) {
    failures.push('ARCH-PUBLIC-ENTRY-01: graph checker accepted a deep package alias');
  }

  const allowed = analyzePackageSources([
    { path: 'packages/primitives/src/index.ts', text: 'export type Marker = string;\n' },
    { path: 'packages/document/src/index.ts', text: "import type { Marker } from '../../primitives/src/index.ts';\nexport type Read = Marker;\n" },
  ]);
  if (allowed.length > 0) failures.push(`ARCH-ALLOWLIST-01: allowed public dependency rejected (${allowed.join('; ')})`);

  // H2-7 static-rule sentinels: each proves the checker actually rejects the violation it
  // claims to (and, for the type-only case, that an `import type` of the same identifier is
  // never mistaken for the value import the rule forbids).
  const servicesDocumentSurfaceViolation = checkStaticRules([
    { path: 'packages/services/files/sentinel.ts', text: "import { openTextDocument } from '../../document/src/index.ts';\n" },
  ]);
  if (!servicesDocumentSurfaceViolation.some((failure) => failure.includes('ARCH-SERVICES-DOCUMENT-SURFACE-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-01: graph checker accepted a services value import of openTextDocument');
  }
  const servicesDocumentSurfaceTypeOnly = checkStaticRules([
    { path: 'packages/services/files/sentinel-type.ts', text: "import type { TextFileDocument } from '../../document/src/index.ts';\n" },
  ]);
  if (servicesDocumentSurfaceTypeOnly.some((failure) => failure.includes('ARCH-SERVICES-DOCUMENT-SURFACE-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-02: graph checker rejected a type-only TextFileDocument import');
  }

  const longAppFunction = checkStaticRules([
    { path: 'apps/xi/src/sentinel.ts', text: `function tooLong() {\n${'  const x = 1;\n'.repeat(160)}}\n` },
  ]);
  if (!longAppFunction.some((failure) => failure.includes('ARCH-APP-FUNCTION-LENGTH-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-03: graph checker accepted an over-length apps/xi function body');
  }

  const uiRenderSelfMutation = checkStaticRules([
    { path: 'packages/ui/sentinel.ts', text: 'class X { renderSelf() { this.#workbench.setViewScroll(1); } }\n' },
  ]);
  if (!uiRenderSelfMutation.some((failure) => failure.includes('ARCH-UI-RENDER-READONLY-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-04: graph checker accepted a renderSelf body calling a workbench setter');
  }

  const uiRenderSelfReadOnly = checkStaticRules([
    { path: 'packages/ui/sentinel-ok.ts', text: 'class X { renderSelf() { this.ctx.setCursorPosition(1, 2); buffer.setCell(0, 0, "a"); } }\n' },
  ]);
  if (uiRenderSelfReadOnly.some((failure) => failure.includes('ARCH-UI-RENDER-READONLY-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-07: graph checker rejected read-only OpenTUI render-context calls in renderSelf');
  }

  const segmenterInFunction = checkStaticRules([
    { path: 'packages/vim/sentinel.ts', text: 'function f() { const s = new Intl.Segmenter("en", { granularity: "word" }); return s; }\n' },
  ]);
  if (!segmenterInFunction.some((failure) => failure.includes('ARCH-MODULE-LEVEL-SEGMENTER-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-05: graph checker accepted a per-call Intl.Segmenter construction');
  }
  const segmenterAtModuleLevel = checkStaticRules([
    { path: 'packages/vim/sentinel-ok.ts', text: 'const s = new Intl.Segmenter("en", { granularity: "word" });\nfunction f() { return s; }\n' },
  ]);
  if (segmenterAtModuleLevel.some((failure) => failure.includes('ARCH-MODULE-LEVEL-SEGMENTER-01'))) {
    failures.push('ARCH-STATIC-RULE-SENTINEL-06: graph checker rejected a module-level Intl.Segmenter const');
  }

  return failures;
}

interface LexToken {
  readonly kind: 'identifier' | 'string' | 'punctuation';
  readonly text: string;
  readonly line: number;
}

/** Small TS/JS lexer for module specifiers; comments and string contents are skipped safely. */
function importedSpecifiers(source: string, fileName: string): { readonly specifier: string; readonly location: string }[] {
  const output: { readonly specifier: string; readonly location: string }[] = [];
  const tokens = lexSource(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== 'identifier') continue;
    const next = tokens[index + 1];
    if (token.text === 'import') {
      if (next?.text === '.' || next === undefined) continue;
      if (next.text === '(') {
        append(tokens[index + 2], token.line);
      } else if (next.kind === 'string') {
        append(next, token.line);
      } else {
        appendFromClause(index, token.line);
      }
    } else if (token.text === 'export') {
      appendFromClause(index, token.line);
    } else if (token.text === 'require' && next?.text === '(') {
      const previous = tokens[index - 1];
      if (previous?.text !== '.' && previous?.text !== '?.') append(tokens[index + 2], token.line);
    }
  }
  return output;

  function append(candidate: LexToken | undefined, line: number): void {
    if (candidate?.kind === 'string') output.push({ specifier: candidate.text, location: `${fileName}:${line}` });
  }

  function appendFromClause(start: number, line: number): void {
    let braces = 0;
    let brackets = 0;
    let parentheses = 0;
    for (let index = start + 1; index < tokens.length; index += 1) {
      const candidate = tokens[index];
      if (candidate === undefined) break;
      if (candidate.text === ';' && braces === 0 && brackets === 0 && parentheses === 0) break;
      if (candidate.line > line && braces === 0 && brackets === 0 && parentheses === 0 && isStatementStart(candidate)) break;
      if (candidate.text === 'from' && braces === 0 && brackets === 0 && parentheses === 0) {
        append(tokens[index + 1], line);
        return;
      }
      if (candidate.text === '{') braces += 1;
      else if (candidate.text === '}') braces = Math.max(0, braces - 1);
      else if (candidate.text === '[') brackets += 1;
      else if (candidate.text === ']') brackets = Math.max(0, brackets - 1);
      else if (candidate.text === '(') parentheses += 1;
      else if (candidate.text === ')') parentheses = Math.max(0, parentheses - 1);
    }
  }
}

function lexSource(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;
    if (char === '\n') { line += 1; index += 1; continue; }
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const tokenLine = line;
      let value = '';
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break;
        if (current === quote) { index += 1; break; }
        if (current === '\n') line += 1;
        if (current === '\\') {
          const escaped = source[index + 1];
          if (escaped !== undefined) {
            value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
            index += 2;
            continue;
          }
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'string', text: value, line: tokenLine });
      continue;
    }
    if (char === '`') {
      const tokenLine = line;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\n') line += 1;
        if (current === '\\') { index += 2; continue; }
        index += 1;
        if (current === '`') break;
      }
      tokens.push({ kind: 'punctuation', text: '`', line: tokenLine });
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'identifier', text: source.slice(start, index), line });
      continue;
    }
    const punctuation = char === '?' && source[index + 1] === '.' ? '?.' : char;
    tokens.push({ kind: 'punctuation', text: punctuation, line });
    index += punctuation.length;
  }
  return tokens;
}

function isStatementStart(token: LexToken): boolean {
  return token.kind === 'identifier' && ['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'return', 'if', 'for', 'while', 'throw', 'export', 'import'].includes(token.text);
}

function ownerOf(path: string): Owner | undefined {
  const normalized = normalizeSourcePath(path);
  if (normalized.startsWith('apps/xi/')) return 'app';
  const match = /^packages\/([^/]+)\//u.exec(normalized);
  if (match === null) return undefined;
  const candidate = match[1];
  return candidate !== undefined && allOwners.includes(candidate as Owner) && candidate !== 'app'
    ? candidate as Owner
    : undefined;
}

const SERVICES_FEATURES = new Set(['language', 'syntax', 'search', 'files', 'git', 'formatting', 'persistence', 'tasks', 'navigation', 'config']);

/** The `packages/services/<feature>/` this path lives under, if any (not `packages/services/src/`). */
function servicesFeatureOf(path: string): string | undefined {
  const match = /^packages\/services\/([^/]+)\//u.exec(normalizeSourcePath(path));
  const candidate = match?.[1];
  return candidate !== undefined && SERVICES_FEATURES.has(candidate) ? candidate : undefined;
}

function ownerOfSpecifier(specifier: string, importer: string, units: ReadonlyMap<string, SourceUnit>): Owner | undefined {
  const alias = /^@xi\/([^/]+)(?:\/|$)/u.exec(specifier);
  if (alias !== null) {
    const candidate = alias[1];
    return candidate !== undefined && knownPackages.has(candidate as Owner) ? candidate as Owner : undefined;
  }
  if (!specifier.startsWith('.')) return undefined;
  const resolved = resolveRelativeTarget(importer, specifier, units);
  return resolved === undefined ? undefined : ownerOf(resolved);
}

function resolveRelativeTarget(importer: string, specifier: string, units: ReadonlyMap<string, SourceUnit>): string | undefined {
  if (!specifier.startsWith('.')) {
    const alias = /^@xi\/([^/]+)(.*)$/u.exec(specifier);
    const owner = alias?.[1];
    const suffix = alias?.[2];
    if (owner === undefined || suffix === undefined || !knownPackages.has(owner as Owner)) return undefined;
    return suffix === '' ? `packages/${owner}/src/index.ts` : `packages/${owner}/__deep_import__/${suffix.replace(/^\//u, '')}`;
  }
  const base = normalizeSourcePath(join(dirname(importer), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (units.has(candidate)) return candidate;
  }
  return undefined;
}

function isPublicEntryPoint(path: string, owner: Owner): boolean {
  const expected = owner === 'app' ? 'apps/xi/src/index.ts' : `packages/${owner}/src/index.ts`;
  const normalized = normalizeSourcePath(path);
  return normalized === expected || normalized.startsWith(`packages/${owner}/src/entrypoints/`);
}

function validateExternal(owner: Owner, specifier: string, importer: string): string | undefined {
  const normalized = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  if (specifier.startsWith('node:') || forbiddenNodeModules.has(specifier)) {
    return owner === 'platform' ? undefined : `${importer}: OS module ${specifier} is only allowed in packages/platform`;
  }
  if (specifier.startsWith('@opentui/')) {
    return owner === 'ui' ? undefined : `${importer}: OpenTUI dependency ${specifier} is only allowed in packages/ui`;
  }
  if (owner === 'platform' && forbiddenNodeModules.has(normalized)) return undefined;
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (packageName !== undefined && ownerExternalDependencies[owner]?.has(packageName)) {
    if (packageName.startsWith('vscode-') && !normalizeSourcePath(importer).startsWith('packages/services/language/')) {
      return `${importer}: LSP dependency ${specifier} is only allowed in packages/services/language`;
    }
    if (packageName === 'web-tree-sitter' && !normalizeSourcePath(importer).startsWith('packages/services/syntax/')) {
      return `${importer}: tree-sitter dependency ${specifier} is only allowed in packages/services/syntax`;
    }
    return undefined;
  }
  // Composition-root asset embedding (`import(x, { with: { type: 'file' } })`) of pinned
  // grammar/runtime wasm and highlight queries; data files, not code dependencies.
  if (owner === 'app' && /\.(?:wasm|scm)$/.test(specifier)) return undefined;
  return `${importer}: undeclared external dependency ${specifier} in ${owner}`;
}

function findCycles<Node extends string>(edges: ReadonlyMap<Node, ReadonlySet<Node>>): string[] {
  const complete = new Set<Node>();
  const active: Node[] = [];
  const emitted = new Set<string>();
  const failures: string[] = [];
  const visit = (node: Node): void => {
    const activeIndex = active.indexOf(node);
    if (activeIndex >= 0) {
      const cycle = [...active.slice(activeIndex), node];
      const key = cycle.join(' -> ');
      if (!emitted.has(key)) {
        emitted.add(key);
        failures.push(`import cycle: ${key}`);
      }
      return;
    }
    if (complete.has(node)) return;
    active.push(node);
    for (const dependency of edges.get(node) ?? []) visit(dependency);
    active.pop();
    complete.add(node);
  };
  for (const node of edges.keys()) visit(node);
  return failures;
}

function normalizeSourcePath(value: string): string {
  return normalize(value).split(sep).join('/').replace(/^\.\//u, '');
}

if (import.meta.main) {
  const failures = checkImportGraph(process.cwd());
  if (failures.length > 0) {
    console.error(`Architecture import graph failed (${failures.length}):`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log('Architecture imports satisfy the public DAG; reverse-import and cycle sentinels rejected as expected.');
}
