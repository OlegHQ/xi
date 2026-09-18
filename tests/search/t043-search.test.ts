import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessPort } from '../../packages/platform/src/index';
import {
  InMemorySearchBackend,
  RealtimeSearchService,
  RipgrepSearchBackend,
  type SearchBackend,
  type SearchQuery,
} from '../../packages/services/search/index';
import { formatSearchLines } from '../../packages/ui/search/index';
import { CancellationSource, type CancellationToken, type ProcessHandle, type ProcessPort, type ProcessSpec, type Result } from '../../packages/contracts/src/index';

const query = (value: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({ rootId: 'root', rootPath: '/workspace', query: value, ...extra });

async function contentAndBufferSources(): Promise<void> {
  const service = new RealtimeSearchService({ backend: new InMemorySearchBackend([
    { rootId: 'root', path: 'src/a.ts', text: 'alpha\nbeta alpha', diskHash: 'a' },
    { rootId: 'root', path: 'src/b.ts', text: 'alpha', diskHash: 'b' },
  ]), debounceMilliseconds: 0, defaultLimit: 10 });
  service.setBufferSources([{ rootId: 'root', path: 'src/a.ts', version: 7, text: 'dirty alpha' }]);
  const result = await service.query(query('alpha'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.matches[0]?.source, 'buffer', 'dirty open buffer replaces disk result');
  assert.equal(result.value.totalMatches, 2);
  assert.equal(result.value.matches[0]?.documentVersion, 7);
  assert.match(formatSearchLines(result.value, 60, 4).join('\n'), /src\/a\.ts/);
  service.dispose();
}

class DelayedBackend implements SearchBackend {
  readonly requests: { readonly generation: number; readonly resolve: (result: Result<readonly [], never>) => void }[] = [];
  search(_query: SearchQuery, _token: CancellationToken, generation: number): Promise<Result<readonly [], never>> {
    return new Promise((resolve) => { this.requests.push({ generation, resolve }); });
  }
}

async function staleGenerationIsRejected(): Promise<void> {
  const backend = new DelayedBackend();
  const service = new RealtimeSearchService({ backend, debounceMilliseconds: 0 });
  const first = service.query(query('old'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  const second = service.query(query('new'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(backend.requests.length, 2);
  backend.requests[0]?.resolve({ ok: true, value: Object.freeze([]) });
  const stale = await first;
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, 'stale');
  backend.requests[1]?.resolve({ ok: true, value: Object.freeze([]) });
  const latest = await second;
  assert.equal(latest.ok, true);
  assert.equal(service.model.query.query, 'new');
  service.dispose();
}

async function invalidRegexKeepsPriorResults(): Promise<void> {
  const service = new RealtimeSearchService({ backend: new InMemorySearchBackend([{ rootId: 'root', path: 'x', text: 'needle' }]), debounceMilliseconds: 0 });
  const valid = await service.query(query('needle'));
  assert.equal(valid.ok, true);
  const invalid = await service.query(query('[', { regex: true }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.kind, 'invalid-regex');
  assert.equal(service.model.state, 'stale');
  assert.equal(service.model.matches.length, 1);
  service.cancel();
  assert.equal(service.model.state, 'stale');
  service.dispose();
}

async function productionRipgrepPath(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-t043-search-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'unicode.txt'), 'Aé界🙂 needle\n', 'utf8');
  await writeFile(join(root, '.hidden.txt'), 'needle hidden\n', 'utf8');
  const invalidName = Buffer.concat([Buffer.from(root), Buffer.from([0x2f, 0x62, 0x61, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74])]);
  await writeFile(invalidName, 'needle encoded\n');
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  const backend = new RipgrepSearchBackend({ process: new NodeProcessPort(), environment });
  const cancellation = new CancellationSource();
  const result = await backend.search(query('needle', { rootPath: root }), cancellation.token, 11);
  cancellation.dispose();
  assert.equal(result.ok, true, 'native ripgrep returns matches');
  if (!result.ok) return;
  const unicode = result.value.find((match) => match.path === 'src/unicode.txt');
  assert.equal(unicode?.range.startUtf16, 6, 'rg byte offsets are converted to UTF-16 columns');
  assert.equal(unicode?.range.endUtf16, 12);
  assert.ok(result.value.some((match) => match.path.startsWith('base64:')), 'invalid filenames retain rg encoded paths');

  const hiddenDefault = await backend.search(query('hidden', { rootPath: root }), new CancellationSource().token, 12);
  assert.equal(hiddenDefault.ok, true);
  if (hiddenDefault.ok) assert.equal(hiddenDefault.value.some((match) => match.path === '.hidden.txt'), false);
  const hiddenEnabled = await backend.search(query('hidden', { rootPath: root, includeHidden: true }), new CancellationSource().token, 13);
  assert.equal(hiddenEnabled.ok, true);
  if (hiddenEnabled.ok) assert.equal(hiddenEnabled.value.some((match) => match.path === '.hidden.txt'), true);

  await Promise.all(Array.from({ length: 90 }, (_, index) => writeFile(join(root, `flood-${index}.txt`), `${'needle '.repeat(80)}\n`, 'utf8')));
  const flooded = new RipgrepSearchBackend({ process: new NodeProcessPort(), environment, maxOutputBytes: 4_096 });
  const floodResult = await flooded.search(query('needle', { rootPath: root }), new CancellationSource().token, 14);
  // Hitting the output-byte cap must not discard matches already parsed before the cap: the
  // bounded parser stops rg and returns whatever complete lines it already read, exactly like
  // reaching maxResults.
  assert.equal(floodResult.ok, true, 'output flood keeps matches already parsed before the byte cap');
  if (floodResult.ok) assert.ok(floodResult.value.length > 0, 'flooded search still returns the matches parsed before the cap');
}

async function cancelledDebounceResolves(): Promise<void> {
  const backend = new InMemorySearchBackend([]);
  const service = new RealtimeSearchService({ backend, debounceMilliseconds: 100 });
  const pending = service.query(query('first'));
  service.cancel();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'stale', 'cancelled debounce does not leave a hanging promise');
  service.dispose();
}

class LateOutputProcessPort implements ProcessPort {
  readonly releases: Array<() => void> = [];

  spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, { readonly code: string; readonly message: string; readonly retryable: boolean }>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.releases.push(release);
    spec.cancellation.onCancel(release);
    const output = (async function* (): AsyncIterable<Uint8Array> {
      await gate;
      yield new TextEncoder().encode('{"type":"match","data":{"path":{"text":"late.txt"},"lines":{"text":"late needle\\n"},"line_number":1,"submatches":[{"start":5,"end":11}]}}\n');
    })();
    const exit = gate.then(() => ({ ok: true, value: { code: 0, signal: null } } as const));
    const handle: ProcessHandle = {
      stdin: null,
      stdout: output,
      stderr: (async function* (): AsyncIterable<Uint8Array> { })(),
      exit,
      terminate: async () => { release(); await exit; },
      dispose: () => { release(); },
    };
    return Promise.resolve({ ok: true, value: handle });
  }
}

async function processExitRaceRejectsLateOutput(): Promise<void> {
  const process = new LateOutputProcessPort();
  const service = new RealtimeSearchService({ backend: new RipgrepSearchBackend({ process }), debounceMilliseconds: 0 });
  const first = service.query(query('first'));
  for (let attempt = 0; attempt < 100 && process.releases.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = service.query(query('second'));
  for (let attempt = 0; attempt < 100 && process.releases.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(process.releases.length, 2, 'replacement query launches a new process while the old one exits');
  process.releases[1]?.();
  const stale = await first;
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, 'stale', 'late output from the exiting process is rejected');
  const latest = await second;
  assert.equal(latest.ok, true);
  service.dispose();
}

class StreamingBatchBackend implements SearchBackend {
  async search(query: SearchQuery, _token: CancellationToken, generation: number, onBatch?: (matches: readonly import('../../packages/services/search/index').SearchMatch[]) => void): Promise<Result<readonly import('../../packages/services/search/index').SearchMatch[], never>> {
    const files = [
      { path: 'src/z.ts', line: 3 },
      { path: 'src/a.ts', line: 1 },
      { path: 'src/m.ts', line: 5 },
    ];
    const all = files.map((file, index) => Object.freeze({
      id: `${query.rootId}:${file.path}:${file.line}:0:${generation}`,
      rootId: query.rootId,
      path: file.path,
      line: file.line,
      range: Object.freeze({ startUtf16: 0, endUtf16: 6 }),
      lineText: 'needle',
      snippet: 'needle',
      source: 'disk' as const,
      generation,
      _order: index,
    }));
    for (const match of all) {
      onBatch?.(Object.freeze([match]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { ok: true, value: Object.freeze(all) };
  }
}

async function streamedBatchesScanBuffersOnceAndMergeCorrectly(): Promise<void> {
  let textReads = 0;
  const bufferSource = {
    rootId: 'root',
    path: 'src/buffered.ts',
    version: 3,
    get text(): string { textReads += 1; return 'needle here\nsecond needle'; },
  };
  const service = new RealtimeSearchService({
    backend: new StreamingBatchBackend(),
    debounceMilliseconds: 0,
    defaultLimit: 100,
    bufferSourceProvider: () => [bufferSource],
  });
  const result = await service.query(query('needle'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(textReads, 1, 'dirty-buffer text is scanned once per query run, not once per streamed batch');
  const paths = result.value.matches.map((match) => match.path);
  assert.deepEqual(paths, ['src/a.ts', 'src/buffered.ts', 'src/buffered.ts', 'src/m.ts', 'src/z.ts'], 'final published matches are sorted by path/line regardless of streaming arrival order');
  assert.equal(result.value.totalMatches, 5);
  service.dispose();
}

class HugeMatchProcessPort implements ProcessPort {
  linesYielded = 0;
  terminated = false;

  spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, { readonly code: string; readonly message: string; readonly retryable: boolean }>> {
    const total = 100_000;
    const self = this;
    let resolveExit!: (value: { readonly code: number | null; readonly signal: string | null }) => void;
    const exit = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => { resolveExit = resolve; });
    const output = (async function* (): AsyncIterable<Uint8Array> {
      for (let index = 0; index < total; index += 1) {
        if (self.terminated) return;
        self.linesYielded += 1;
        yield new TextEncoder().encode(`{"type":"match","data":{"path":{"text":"big.txt"},"lines":{"text":"needle ${index}\\n"},"line_number":${index + 1},"submatches":[{"start":0,"end":6}]}}\n`);
      }
    })();
    const handle: ProcessHandle = {
      stdin: null,
      stdout: output,
      stderr: (async function* (): AsyncIterable<Uint8Array> { })(),
      exit: exit.then((value) => ({ ok: true, value } as const)),
      terminate: async () => { self.terminated = true; resolveExit({ code: null, signal: 'SIGTERM' }); },
      dispose: () => { self.terminated = true; resolveExit({ code: 1, signal: 'SIGTERM' }); },
    };
    return Promise.resolve({ ok: true, value: handle });
  }
}

async function ripgrepStopsAtMaxResults(): Promise<void> {
  const processPort = new HugeMatchProcessPort();
  const backend = new RipgrepSearchBackend({ process: processPort });
  const cancellation = new CancellationSource();
  const result = await backend.search(query('needle', { rootPath: '/workspace', maxResults: 50 }), cancellation.token, 1);
  cancellation.dispose();
  assert.equal(result.ok, true, 'T-SEARCH-CAP-01 a capped search still succeeds rather than reporting a backend failure');
  if (!result.ok) return;
  assert.equal(result.value.length, 50, 'T-SEARCH-CAP-02 exactly maxResults matches are retained');
  assert.ok(processPort.linesYielded < 100_000, `T-SEARCH-CAP-03 parsing stops well before the full 100k-match stream is read (read ${processPort.linesYielded})`);
  assert.ok(processPort.terminated, 'T-SEARCH-CAP-04 the backend process is terminated once the cap is reached');
}

await contentAndBufferSources();
await staleGenerationIsRejected();
await invalidRegexKeepsPriorResults();
await productionRipgrepPath();
await cancelledDebounceResolves();
await processExitRaceRejectsLateOutput();
await streamedBatchesScanBuffersOnceAndMergeCorrectly();
await ripgrepStopsAtMaxResults();
console.log('T043 search passed production ripgrep, encoded paths, UTF-16 ranges, output bounds, dirty-buffer replacement, regex flags, process-exit cancellation and streamed-batch merge fixtures');
