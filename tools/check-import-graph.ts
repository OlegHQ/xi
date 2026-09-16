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
  ui: new Set(['@opentui/core']),
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
      }
    }
  }

  failures.push(...findCycles(fileEdges));
  return failures;
}

/** CI's negative fixtures prove the checker rejects a reverse import and a cycle. */
export function checkImportGraph(repositoryRoot: string): string[] {
  const failures = analyzePackageSources(collectPackageSources(repositoryRoot));
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
    return undefined;
  }
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
