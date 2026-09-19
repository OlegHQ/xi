import { CancellationSource } from '../../contracts/src/index';
import type { Disposable, PlatformFailure, ProcessPort, Result } from '../../contracts/src/index';

export type GitEntryState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';
export interface GitStatusEntry { readonly path: string; readonly originalPath?: string; readonly state: GitEntryState; readonly indexCode: string; readonly worktreeCode: string; readonly staged: boolean; readonly unstaged: boolean; readonly conflict: boolean; }
export interface GitStatusSnapshot { readonly root: string; readonly generation: number; readonly entries: readonly GitStatusEntry[]; readonly branch: string | undefined; }
export type GitFailure = { readonly kind: 'malformed' | 'unavailable' | 'stale' | 'disposed' | 'apply'; readonly message: string };

export function parsePorcelainV2Z(root: string, bytes: Uint8Array, generation: number, branch?: string): Result<GitStatusSnapshot, GitFailure> {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, error: { kind: 'malformed', message: 'git status is not UTF-8' } }; }
  const values = text.split('\0').filter((value) => value.length > 0); const entries: GitStatusEntry[] = [];
  for (let index = 0; index < values.length; index += 1) { const value = values[index]; if (value === undefined) continue; if (value.startsWith('# ')) continue; if (value.startsWith('1 ')) { const fields = value.split(' '); const code = fields[1] ?? '  '; const path = fields.slice(8).join(' '); entries.push(entry(path, code[0] ?? ' ', code[1] ?? ' ')); continue; } if (value.startsWith('2 ')) { const fields = value.split(' '); const code = fields[1] ?? '  '; const path = fields.slice(9).join(' '); const original = values[index + 1]; if (original === undefined) return { ok: false, error: { kind: 'malformed', message: 'rename record missing original path' } }; index += 1; entries.push({ ...entry(path, code[0] ?? ' ', code[1] ?? ' '), state: 'renamed', originalPath: original }); continue; } if (value.startsWith('u ')) { const fields = value.split(' '); const path = fields.slice(10).join(' '); entries.push({ ...entry(path, 'U', 'U'), state: 'conflicted', conflict: true, staged: true, unstaged: true }); continue; } if (value.startsWith('? ')) { entries.push({ ...entry(value.slice(2), '?', '?'), state: 'untracked', staged: false, unstaged: true, conflict: false }); continue; } if (value.startsWith('! ')) { entries.push({ ...entry(value.slice(2), '!', '!'), state: 'ignored', staged: false, unstaged: false, conflict: false }); continue; } return { ok: false, error: { kind: 'malformed', message: `unknown porcelain record ${value.slice(0, 2)}` } }; }
  return { ok: true, value: Object.freeze({ root, generation, entries: Object.freeze(entries), branch }) };
}

// `git status --porcelain=v2`'s XY codes use '.' (not a space, unlike porcelain v1) for the
// unmodified side of an ordinary changed entry -- see `git-status(1)`'s porcelain v2 format.
// `staged`/`unstaged` must treat '.' as "no change on this side", or an index-only change
// ('A.') reads as also unstaged and a worktree-only change ('.M') reads as also staged.
function entry(path: string, indexCode: string, worktreeCode: string): GitStatusEntry { const conflict = indexCode === 'U' || worktreeCode === 'U'; return Object.freeze({ path, state: stateFor(indexCode, worktreeCode), indexCode, worktreeCode, staged: indexCode !== '.' && indexCode !== ' ' && indexCode !== '?' && indexCode !== '!', unstaged: worktreeCode !== '.' && worktreeCode !== ' ' && worktreeCode !== '?' && worktreeCode !== '!', conflict }); }
function stateFor(indexCode: string, worktreeCode: string): GitEntryState { if (indexCode === 'U' || worktreeCode === 'U') return 'conflicted'; if (indexCode === 'R' || worktreeCode === 'R') return 'renamed'; if (indexCode === 'D' || worktreeCode === 'D') return 'deleted'; if (indexCode === 'A' || worktreeCode === 'A') return 'added'; return 'modified'; }

export class GitStatusCache implements Disposable {
  #snapshot: GitStatusSnapshot | undefined; #disposed = false;
  publish(snapshot: GitStatusSnapshot): Result<GitStatusSnapshot, GitFailure> { if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'git cache disposed' } }; if (this.#snapshot && snapshot.generation < this.#snapshot.generation) return { ok: false, error: { kind: 'stale', message: 'git status generation is stale' } }; this.#snapshot = snapshot; return { ok: true, value: snapshot }; }
  get snapshot(): GitStatusSnapshot | undefined { return this.#snapshot; }
  dispose(): void { this.#disposed = true; this.#snapshot = undefined; }
}

export interface GitMutationExecutor { run(argv: readonly string[], input?: string): Promise<Result<{ readonly stdout: string; readonly stderr: string; readonly code: number }, GitFailure>>; }
export interface GitMutationContext { readonly root: string; readonly generation: number; readonly expectedGeneration: number; }
export type GitMutationFailure = GitFailure | { readonly kind: 'invalid-message' | 'stale-generation' | 'no-target'; readonly message: string };
/** Explicit Git mutations; callers must choose stage/unstage/discard/commit separately. */
export class GitMutationCoordinator implements Disposable {
  readonly #executor: GitMutationExecutor; #disposed = false; #busy = false;
  constructor(executor: GitMutationExecutor) { this.#executor = executor; }
  async stage(paths: readonly string[], context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { return this.run(['git', 'add', '--', ...paths], paths, context); }
  async unstage(paths: readonly string[], context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { return this.run(['git', 'reset', '--', ...paths], paths, context); }
  async discard(paths: readonly string[], context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { return this.run(['git', 'restore', '--', ...paths], paths, context); }
  async commit(message: string, context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { if (message.trim().length === 0) return { ok: false, error: { kind: 'invalid-message', message: 'commit message is empty' } }; return this.run(['git', 'commit', '-F', '-'], ['commit'], context, message); }
  async checkoutBranch(name: string, context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { if (!/^[A-Za-z0-9._/-]+$/u.test(name) || name.startsWith('-')) return { ok: false, error: { kind: 'invalid-message', message: 'branch name is invalid' } }; return this.run(['git', 'switch', name], [name], context); }
  async stash(action: 'push' | 'pop' | 'list', context: GitMutationContext, message?: string): Promise<Result<void, GitMutationFailure>> { const argv = action === 'push' ? ['git', 'stash', 'push', ...(message === undefined ? [] : ['-m', message])] : ['git', 'stash', action]; return this.run(argv, ['stash'], context); }
  async remote(action: 'fetch' | 'pull' | 'push', remote: string, context: GitMutationContext): Promise<Result<void, GitMutationFailure>> { if (!/^[A-Za-z0-9._/-]+$/u.test(remote) || remote.startsWith('-')) return { ok: false, error: { kind: 'invalid-message', message: 'remote name is invalid' } }; return this.run(['git', action, remote], [remote], context); }
  private async run(argv: readonly string[], paths: readonly string[], context: GitMutationContext, input?: string): Promise<Result<void, GitMutationFailure>> { if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'git mutation disposed' } }; if (this.#busy) return { ok: false, error: { kind: 'apply', message: 'another git mutation is running' } }; if (context.expectedGeneration !== context.generation) return { ok: false, error: { kind: 'stale-generation', message: 'Git status changed; refresh before mutating' } }; if (paths.length === 0) return { ok: false, error: { kind: 'no-target', message: 'Git mutation has no target' } }; this.#busy = true; try { const result = await this.#executor.run(argv, input); return result.ok && result.value.code === 0 ? { ok: true, value: undefined } : result.ok ? { ok: false, error: { kind: 'unavailable', message: result.value.stderr || 'Git command failed' } } : result; } finally { this.#busy = false; } }
  dispose(): void { this.#disposed = true; }
}

export interface GitHistoryEntry { readonly id: string; readonly commit: string; readonly subject: string; readonly author: string; readonly timestamp: number; }
export interface GitConflictState { readonly path: string; readonly base: string; readonly ours: string; readonly theirs: string; readonly result: string; readonly unresolved: boolean; }
export class GitHistoryController implements Disposable {
  #disposed = false; #history: readonly GitHistoryEntry[] = Object.freeze([]); #conflicts = new Map<string, GitConflictState>();
  publishHistory(entries: readonly GitHistoryEntry[]): void { if (!this.#disposed) this.#history = Object.freeze([...entries]); }
  history(): readonly GitHistoryEntry[] { return this.#history; }
  openReadOnly(id: string): Result<GitHistoryEntry, GitFailure> { const entry = this.#history.find((item) => item.id === id); return entry === undefined ? { ok: false, error: { kind: 'unavailable', message: 'history entry not found' } } : { ok: true, value: entry }; }
  setConflict(state: GitConflictState): void { if (!this.#disposed) this.#conflicts.set(state.path, Object.freeze({ ...state })); }
  conflict(path: string): GitConflictState | undefined { return this.#conflicts.get(path); }
  markResolved(path: string, gitUnmerged: boolean): Result<void, GitFailure> { const state = this.#conflicts.get(path); if (state === undefined) return { ok: false, error: { kind: 'unavailable', message: 'conflict path not tracked' } }; if (gitUnmerged) return { ok: false, error: { kind: 'stale', message: 'Git still reports unmerged entries' } }; this.#conflicts.set(path, Object.freeze({ ...state, unresolved: false })); return { ok: true, value: undefined }; }
  dispose(): void { this.#disposed = true; this.#history = Object.freeze([]); this.#conflicts.clear(); }
}

const DEFAULT_STATUS_TIMEOUT_MILLISECONDS = 5_000;
/** Mutations (stage/commit/push/pull/etc.) can legitimately run far longer than a status
 * poll, e.g. a push/pull that waits on the network or a large commit hook; the 5 s status
 * timeout would abort those mid-flight. */
const DEFAULT_MUTATION_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface GitStatusServiceOptions {
  readonly process: ProcessPort;
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
}

/**
 * Runs `git status --porcelain=v2 -z --branch` through the platform process port,
 * publishes into a GitStatusCache with an increasing generation and coalesces
 * concurrent refresh requests into at most one process in flight plus one rerun.
 */
export class GitStatusService implements Disposable {
  readonly #process: ProcessPort;
  readonly #root: string;
  readonly #env: Readonly<Record<string, string>>;
  readonly #timeoutMilliseconds: number;
  readonly #cache = new GitStatusCache();
  readonly #listeners = new Set<(snapshot: GitStatusSnapshot) => void>();
  #generation = 0;
  #running = false;
  #rerunRequested = false;
  #notRepo = false;
  #disposed = false;
  #activeCancellation: CancellationSource | undefined;

  constructor(options: GitStatusServiceOptions) {
    this.#process = options.process;
    this.#root = options.root;
    this.#env = options.env ?? {};
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS;
  }

  get snapshot(): GitStatusSnapshot | undefined { return this.#cache.snapshot; }

  subscribe(listener: (snapshot: GitStatusSnapshot) => void): Disposable {
    if (this.#disposed) return { dispose: () => {} };
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  async refresh(): Promise<void> {
    if (this.#disposed || this.#notRepo) return;
    if (this.#running) { this.#rerunRequested = true; return; }
    this.#running = true;
    try {
      do {
        this.#rerunRequested = false;
        await this.#runOnce();
      } while (this.#rerunRequested && !this.#disposed && !this.#notRepo);
    } finally {
      this.#running = false;
    }
  }

  async #runOnce(): Promise<void> {
    const generation = ++this.#generation;
    const cancellation = new CancellationSource();
    this.#activeCancellation = cancellation;
    const spawned = await this.#process.spawn({
      argv: ['git', 'status', '--porcelain=v2', '-z', '--branch'],
      cwd: this.#root,
      env: this.#env,
      stdin: 'ignore',
      timeoutMilliseconds: this.#timeoutMilliseconds,
      cancellation: cancellation.token,
    });
    if (!spawned.ok) { this.#notRepo = true; this.#publishEmpty(generation); return; }
    const handle = spawned.value;
    try {
      const [stdout, stderr, exit] = await Promise.all([
        drain(handle.stdout, DEFAULT_MAX_OUTPUT_BYTES),
        drain(handle.stderr, DEFAULT_MAX_OUTPUT_BYTES),
        handle.exit,
      ]);
      if (this.#disposed) return;
      if (!exit.ok || !stdout.ok) { this.#publishEmpty(generation); return; }
      if (exit.value.code !== 0) {
        const stderrText = stderr.ok ? new TextDecoder('utf-8').decode(stderr.value) : '';
        if (exit.value.code === 128 && stderrText.includes('not a git repository')) this.#notRepo = true;
        this.#publishEmpty(generation);
        return;
      }
      const branch = parseBranch(stdout.value);
      const parsed = parsePorcelainV2Z(this.#root, stdout.value, generation, branch);
      if (!parsed.ok) return;
      this.#cache.publish(parsed.value);
      for (const listener of this.#listeners) listener(parsed.value);
    } finally {
      try { handle.dispose(); } catch { /* process exit owns final cleanup */ }
      if (this.#activeCancellation === cancellation) this.#activeCancellation = undefined;
      cancellation.dispose();
    }
  }

  #publishEmpty(generation: number): void {
    if (this.#disposed) return;
    const empty: GitStatusSnapshot = Object.freeze({ root: this.#root, generation, entries: Object.freeze([]), branch: undefined });
    this.#cache.publish(empty);
    for (const listener of this.#listeners) listener(empty);
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#cache.dispose();
    this.#activeCancellation?.cancel();
    this.#activeCancellation = undefined;
  }
}

function parseBranch(bytes: Uint8Array): string | undefined {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  // `-z` output: records end in NUL, which `\S` would swallow ("master\u00001 .M ...").
  const match = /# branch\.head ([^\s\u0000]+)/u.exec(text);
  return match?.[1] === undefined || match[1] === '(detached)' ? undefined : match[1];
}

async function drain(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Result<Uint8Array, PlatformFailure>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > limit) return { ok: false, error: { code: 'output-limit', message: 'git output exceeded limit', retryable: false } };
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    return { ok: false, error: { code: 'read-failed', message: error instanceof Error ? error.message : 'git output could not be read', retryable: false } };
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, value: output };
}

/** GitMutationExecutor implementation over the platform process port; stdin carries commit messages. */
export function createProcessGitMutationExecutor(process: ProcessPort, root: string, env: Readonly<Record<string, string>> = {}, timeoutMilliseconds: number = DEFAULT_MUTATION_TIMEOUT_MILLISECONDS): GitMutationExecutor {
  return {
    async run(argv: readonly string[], input?: string) {
      if (argv.length === 0) return { ok: false, error: { kind: 'apply', message: 'git mutation has no argv' } };
      const cancellation = new CancellationSource();
      const spawned = await process.spawn({
        argv: argv as [string, ...string[]],
        cwd: root,
        env,
        stdin: input === undefined ? 'ignore' : 'pipe',
        timeoutMilliseconds,
        cancellation: cancellation.token,
      });
      if (!spawned.ok) return { ok: false, error: { kind: 'unavailable', message: spawned.error.message } };
      const handle = spawned.value;
      try {
        if (input !== undefined) {
          if (handle.stdin === null) return { ok: false, error: { kind: 'unavailable', message: 'git process has no stdin pipe' } };
          const written = await handle.stdin.write(new TextEncoder().encode(input));
          if (!written.ok) return { ok: false, error: { kind: 'unavailable', message: written.error.message } };
          const closed = await handle.stdin.close();
          if (!closed.ok) return { ok: false, error: { kind: 'unavailable', message: closed.error.message } };
        }
        const [stdout, stderr, exit] = await Promise.all([
          drain(handle.stdout, DEFAULT_MAX_OUTPUT_BYTES),
          drain(handle.stderr, DEFAULT_MAX_OUTPUT_BYTES),
          handle.exit,
        ]);
        if (!exit.ok) return { ok: false, error: { kind: 'unavailable', message: exit.error.message } };
        const decoder = new TextDecoder('utf-8');
        return {
          ok: true,
          value: {
            stdout: stdout.ok ? decoder.decode(stdout.value) : '',
            stderr: stderr.ok ? decoder.decode(stderr.value) : '',
            code: exit.value.code ?? -1,
          },
        };
      } finally {
        try { handle.dispose(); } catch { /* process exit owns final cleanup */ }
      }
    },
  };
}
