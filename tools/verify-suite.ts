#!/usr/bin/env bun
/** Execute aggregate suites and fail if a selector discovers no real fixtures. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { validateConfigLedger } from './check-config-ledger';
import { boundedRunExitCode, runBoundedTasks } from './bounded-tasks';

type SuiteId = 'unit' | 'vim' | 'services' | 'ui' | 'e2e' | 'bench';
type SuiteSpec = Readonly<{
  readonly fixtureRoot: string;
  readonly roots: readonly string[];
  readonly selectors: Readonly<Record<string, readonly string[]>>;
}>;

const standaloneUnitFixtures = ['verify.ts', 't010-text-fidelity.ts', 't011-transactions.ts', 't012-undo-history.ts', 't101-literal-controls.ts'];

const specs: Readonly<Record<SuiteId, SuiteSpec>> = {
  unit: {
    fixtureRoot: 'tests/unit',
    roots: ['tests/architecture', 'tests/config', 'tests/document', ...standaloneUnitFixtures.map((name) => `tests/document/${name}`), 'tests/layout', 'tests/persistence', 'tests/platform', 'tests/selections', 'tests/workbench'],
    selectors: { contributions: ['tests/architecture/t091-lifecycle.test.ts', 'tests/workbench/t090-contributions.test.ts'] },
  },
  vim: { fixtureRoot: 'tests/fixtures/vim', roots: ['tests/vim', 'tests/oracle'], selectors: { config: ['tests/vim/insert-auto-pairs.test.ts', 'tests/vim/insert-smarttab.test.ts', 'tests/vim/t022/t022-insert.test.ts'] } },
  services: {
    fixtureRoot: 'tests/fixtures/services',
    roots: ['tests/files', 'tests/formatting', 'tests/git', 'tests/lsp', 'tests/search', 'tests/services', 'tests/syntax', 'tests/tasks'],
    selectors: {},
  },
  ui: { fixtureRoot: 'tests/fixtures/ui', roots: ['tests/ui'], selectors: {} },
  e2e: {
    fixtureRoot: 'tests/fixtures/e2e',
    roots: ['tests/e2e', 'tests/distribution'],
    selectors: { interaction: ['tests/e2e/t038-session.test.ts', 'tests/e2e/t039-picker.test.ts', 'tests/e2e/t039-picker-pty.py', 'tests/e2e/t040-explorer.test.ts', 'tests/e2e/t040-explorer-pty.py', 'tests/e2e/t1115-empty-cursor-pty.py', 'tests/e2e/t1123-syntax-first-view-pty.py', 'tests/e2e/t043-search-pty.py', 'tests/e2e/search-ignored-dirty-pty.py', 'tests/e2e/t044-replace-pty.py', 'tests/e2e/t049-problems-pty.py', 'tests/e2e/t050-outline-pty.py', 'tests/e2e/t051-completion-pty.py', 'tests/e2e/t052-workspace-pty.py', 'tests/e2e/t045-g3.test.ts', 'tests/e2e/t086-pointer-pty.py', 'tests/e2e/t094-controls.test.ts', 'tests/e2e/t094-controls-pty.py', 'tests/e2e/t094-splitter-pty.py', 'tests/e2e/t094-terminal-pty.py', 'tests/e2e/t094-integration-pty.py', 'tests/e2e/t127-panel-pointer-pty.py', 'tests/e2e/t127-panel-pointer-picker-pty.py', 'tests/e2e/t127-problems-live-diagnostics-pty.py', 'tests/e2e/t128-named-terminal-pty.py', 'tests/e2e/t128-e21-wheel-xterm-pty.py', 'tests/e2e/t128-e21-multiclick-xterm-pty.py', 'tests/e2e/t128-e21-textdrag-xterm-pty.py', 'tests/e2e/t128-e22-splitter-xterm-pty.py', 'tests/e2e/t129-panel-scroll-pty.py', 'tests/e2e/t129-panel-scroll-picker-search-pty.py', 'tests/e2e/t129-context-menu-pty.py', 'tests/e2e/t129-mouse-toggle-pty.py', 'tests/e2e/t130-dot-repeat-pty.py', 'tests/e2e/t130-macro-pty.py', 'tests/e2e/t130-change-repeat-pty.py', 'tests/e2e/t045-e05-search-rapid-typing-pty.py', 'tests/e2e/t045-e15-degraded-missing-rg-pty.py', 'tests/e2e/t045-e13-crash-recovery-pty.py', 'tests/e2e/t045-e11-resize-sequence-pty.py', 'tests/e2e/t045-e12-bracketed-paste-pty.py', 'tests/e2e/t045-e02-picker-preview-pty.py', 'tests/e2e/t045-e02-write-quit-all-pty.py', 'tests/e2e/t045-e03-explorer-filter-reveal-pty.py', 'tests/e2e/t045-e06-replace-dirty-closed-pty.py', 'tests/e2e/t045-e16-narrow-popup-resize-pty.py', 'tests/e2e/t132-theme-switch-pty.py', 'tests/e2e/t132-custom-theme-pty.py', 'tests/e2e/t131-explorer-file-management-pty.py', 'tests/e2e/t045-keyboard-only-journey-pty.py', 'tests/e2e/t060-tasks-pty.py', 'tests/distribution/t064-cli.test.ts', 'tests/distribution/t064-package.test.ts', 'tests/distribution/t064-editor-pty.py', 'tests/distribution/t064-file-pty.py', 'tests/distribution/t064-compiled-pty.py', 'tests/distribution/t064-ex-pty.py', 'tests/distribution/t064-vim-pty.py'] },
  },
  bench: {
    fixtureRoot: 'bench',
    roots: ['bench'],
    selectors: { interaction: ['bench/t039-picker.bench.ts', 'bench/t043-search.bench.ts', 'bench/selections/t089-qualification.ts'], selections: ['bench/selections/t089-qualification.ts'] },
  },
};

const suite = process.argv[2] as SuiteId | undefined;
if (suite === undefined || !(suite in specs)) {
  console.error('verify-suite requires a suite id (unit|vim|services|ui|e2e|bench).');
  process.exit(2);
}
const spec = specs[suite];
const selector = option('--suite');
const keepGoing = process.argv.filter((argument) => argument === '--keep-going').length > 0;
if (process.argv.filter((argument) => argument === '--keep-going').length > 1) throw new Error('--keep-going may be specified once');
if (keepGoing && suite !== 'e2e') throw new Error('--keep-going is only supported for e2e fixtures');
const fixtureRoot = resolve(process.cwd(), spec.fixtureRoot);
const entries = await readdir(fixtureRoot, { withFileTypes: true }).catch(() => []);
if (entries.length === 0) {
  console.error(`Required suite "${suite}" has no fixtures to execute.`);
  console.error(`Checked path: ${fixtureRoot}`);
  console.error('A missing or empty suite must fail release verification.');
  process.exit(1);
}
const manifestPath = join(fixtureRoot, 'manifest.json');
const manifest = await readManifest(manifestPath);
if (manifest === null || manifest.suite !== suite || manifest.fixtures.length === 0) {
  console.error(`Required suite "${suite}" has no valid manifest at ${manifestPath}.`);
  process.exit(1);
}
const roots = [
  ...(selector === undefined ? spec.roots : spec.selectors[selector] ?? []),
  ...(suite === 'e2e' && selector === 'interaction'
    ? (await readdir('tests/e2e')).filter((name) => /^config-.*-pty\.py$/u.test(name)).map((name) => `tests/e2e/${name}`)
    : []),
];
if (roots.length === 0) {
  console.error(`Required suite "${suite}" has no fixtures for selector "${selector}".`);
  process.exit(1);
}
if (suite === 'bench' && (manifest.executables === undefined || (selector !== undefined && roots.some((root) => !manifest.executables?.includes(root))))) {
  throw new Error('Benchmark manifest must declare every selected executable fixture');
}
const files = suite === 'bench'
  ? await discover(selector === undefined ? manifest.executables ?? [] : roots, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  : await discover(roots, (name) => executable(suite, name));
if (files.length === 0) {
  console.error(`Required suite "${suite}" discovered zero executable fixtures.`);
  process.exit(1);
}
if (suite === 'e2e' && selector === 'interaction') {
  const ledger: unknown = JSON.parse(await readFile('docs/configuration-ledger.json', 'utf8'));
  const errors = validateConfigLedger(ledger);
  if (errors.length > 0) throw new Error(`Config ledger is invalid: ${errors.join('; ')}`);
  const selected = new Set(files.map((file) => relative(process.cwd(), file)));
  for (const id of ['unit', 'vim', 'services', 'ui'] as const) {
    const suiteRoots = id === 'vim' ? specs.vim.selectors.config! : specs[id].roots;
    for (const file of await discover(suiteRoots, (name) => executable(id, name))) selected.add(relative(process.cwd(), file));
  }
  const evidence = (ledger as { items: { validation: Record<string, string[]> }[] }).items
    .flatMap((item) => Object.values(item.validation).flatMap((tests) => tests.map((test) => test.split('#', 1)[0]!)));
  const missing = [...new Set(evidence)].filter((path) => !selected.has(path));
  if (missing.length > 0) throw new Error(`Config ledger evidence is absent from release suites: ${missing.join(', ')}`);
}
const suiteStartedAt = performance.now();
const maxConcurrency = suite === 'e2e' ? manifest.maxConcurrency ?? 1 : 1;
console.log(`Suite "${suite}"${selector === undefined ? '' : ` selector "${selector}"`} executing ${files.length} fixture(s) (max concurrency ${maxConcurrency}).`);
if (maxConcurrency > 1 || keepGoing) {
  const run = await runBounded(files, maxConcurrency, keepGoing);
  const failures = files.flatMap((file, index) => {
    const code = run.codes[index];
    return code === undefined || code === 0 ? [] : [{ file, code }];
  });
  const runExitCode = boundedRunExitCode(run);
  if (run.interrupted) {
    console.error('Fixture run interrupted.');
    process.exitCode = runExitCode;
  } else if (failures.length > 0 && keepGoing) {
    console.error(`Suite "${suite}" failed ${failures.length} fixture(s):`);
    for (const failure of failures) console.error(`  ${relative(process.cwd(), failure.file)} (exit ${failure.code})`);
    process.exitCode = runExitCode;
  } else if (failures[0] !== undefined) {
    console.error(`Suite "${suite}" failed at ${relative(process.cwd(), failures[0].file)} (exit ${failures[0].code}).`);
    process.exitCode = runExitCode;
  }
} else {
  for (const file of files) {
    const code = file.endsWith('.py')
      ? await run('python3', [file])
      : await run(process.execPath, file.endsWith('.test.ts') ? ['test', file] : ['run', file]);
    if (code !== 0) {
      console.error(`Suite "${suite}" failed at ${relative(process.cwd(), file)} (exit ${code}).`);
      process.exit(code);
    }
  }
}
if (process.exitCode === undefined || process.exitCode === 0) console.log(`Suite "${suite}" passed ${files.length} fixture(s) in ${Math.round(performance.now() - suiteStartedAt)} ms.`);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '' || process.argv.lastIndexOf(name) !== index) {
    throw new Error(`${name} requires exactly one nonempty value`);
  }
  return value;
}

function executable(id: SuiteId, name: string): boolean {
  return name.endsWith('.test.ts') || (id === 'unit' && (standaloneUnitFixtures.includes(name) || (name.startsWith('test_') && name.endsWith('.py')))) || (id === 'e2e' && name.endsWith('.py'));
}

async function readManifest(path: string): Promise<{ readonly suite: string; readonly fixtures: readonly string[]; readonly executables?: readonly string[]; readonly maxConcurrency?: number } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const suiteValue = record['suite'];
    const fixtureValue = record['fixtures'];
    if (record['schemaVersion'] !== 1 || typeof suiteValue !== 'string' || !Array.isArray(fixtureValue) || !fixtureValue.every((item) => typeof item === 'string' && item.length > 0) || new Set(fixtureValue).size !== fixtureValue.length) return null;
    const executables = record['executables'];
    if (executables !== undefined && (!Array.isArray(executables) || executables.length === 0 || !executables.every((item) => typeof item === 'string' && item.startsWith('bench/') && !item.split('/').includes('..')) || new Set(executables).size !== executables.length)) return null;
    const maxConcurrency = record['maxConcurrency'];
    if (maxConcurrency !== undefined && (!Number.isSafeInteger(maxConcurrency) || (maxConcurrency as number) < 1 || (maxConcurrency as number) > 8)) return null;
    return { suite: suiteValue, fixtures: fixtureValue, ...(executables === undefined ? {} : { executables: executables as string[] }), ...(maxConcurrency === undefined ? {} : { maxConcurrency: maxConcurrency as number }) };
  } catch {
    return null;
  }
}

async function discover(roots: readonly string[], predicate: (name: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  for (const root of roots) {
    const before = result.length;
    await collect(resolve(process.cwd(), root), predicate, result);
    if (result.length === before) throw new Error(`Required fixture root has no executable fixtures: ${root}`);
  }
  return [...new Set(result)].sort();
}

async function collect(path: string, predicate: (name: string) => boolean, result: string[]): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (metadata === null) throw new Error(`Required fixture path is missing: ${path}`);
  if (metadata.isFile()) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!predicate(name)) throw new Error(`Required fixture is not executable: ${path}`);
    result.push(path);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`Unsupported fixture path: ${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child, predicate, result);
    else if (entry.isFile() && predicate(entry.name)) result.push(child);
  }
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveCode) => {
    // A developer's XDG path must not override PTY fixtures that isolate only HOME.
    const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, XDG_CONFIG_HOME: '' } });
    child.once('error', () => resolveCode(1));
    child.once('exit', (code) => resolveCode(code ?? 1));
  });
}

type OutputChunk = { readonly stream: 'stdout' | 'stderr'; readonly bytes: Buffer };
type FixtureResult = { readonly code: number; readonly output: readonly OutputChunk[]; readonly elapsedMilliseconds: number };
type CapturedFixtureResult = { readonly code: number; readonly output: readonly OutputChunk[] };

async function runBounded(files: readonly string[], limit: number, keepGoing: boolean): Promise<Awaited<ReturnType<typeof runBoundedTasks<FixtureResult>>>> {
  const children = new Set<ChildProcess>();
  let interrupted = false;
  const interrupt = (signal: NodeJS.Signals): void => {
    interrupted = true;
    for (const child of children) child.kill(signal);
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    return await runBoundedTasks(files.length, limit, async (index) => {
      const file = files[index]!;
      console.error(`[${index + 1}/${files.length}] ${relative(process.cwd(), file)}`);
      const startedAt = performance.now();
      const command = file.endsWith('.py') ? 'python3' : process.execPath;
      const args = file.endsWith('.py') ? [file] : file.endsWith('.test.ts') ? ['test', file] : ['run', file];
      const result = await runCaptured(command, args, children);
      return { code: result.code, value: { ...result, elapsedMilliseconds: performance.now() - startedAt } };
    }, (_index, result) => {
      console.error(`[${_index + 1}/${files.length}] done in ${Math.round(result.value.elapsedMilliseconds)} ms`);
      for (const chunk of result.value.output) (chunk.stream === 'stdout' ? process.stdout : process.stderr).write(chunk.bytes);
    }, () => interrupted, keepGoing);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

function runCaptured(command: string, args: readonly string[], children: Set<ChildProcess>): Promise<CapturedFixtureResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: '' } });
    children.add(child);
    const output: OutputChunk[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => output.push({ stream: 'stdout', bytes: Buffer.from(chunk) }));
    child.stderr?.on('data', (chunk: Buffer | string) => output.push({ stream: 'stderr', bytes: Buffer.from(chunk) }));
    child.once('error', (error: Error) => output.push({ stream: 'stderr', bytes: Buffer.from(`${error.message}\n`) }));
    child.once('close', (code) => {
      children.delete(child);
      resolveResult({ code: code ?? 1, output });
    });
  });
}
