import type { Disposable, Result } from '../../contracts/src/index';

export type GitEntryState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';
export interface GitStatusEntry { readonly path: string; readonly originalPath?: string; readonly state: GitEntryState; readonly indexCode: string; readonly worktreeCode: string; readonly staged: boolean; readonly unstaged: boolean; readonly conflict: boolean; }
export interface GitStatusSnapshot { readonly root: string; readonly generation: number; readonly entries: readonly GitStatusEntry[]; readonly branch: string | undefined; }
export type GitFailure = { readonly kind: 'malformed' | 'unavailable' | 'stale' | 'disposed' | 'apply'; readonly message: string };

export function parsePorcelainV2Z(root: string, bytes: Uint8Array, generation: number, branch?: string): Result<GitStatusSnapshot, GitFailure> {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, error: { kind: 'malformed', message: 'git status is not UTF-8' } }; }
  const values = text.split('\0').filter((value) => value.length > 0); const entries: GitStatusEntry[] = [];
  for (let index = 0; index < values.length; index += 1) { const value = values[index]; if (value === undefined) continue; if (value.startsWith('# ')) continue; if (value.startsWith('1 ')) { const fields = value.split(' '); const code = fields[1] ?? '  '; const path = fields.slice(8).join(' '); entries.push(entry(path, code[0] ?? ' ', code[1] ?? ' ')); continue; } if (value.startsWith('2 ')) { const fields = value.split(' '); const code = fields[1] ?? '  '; const path = fields.slice(9).join(' '); const original = values[index + 1]; if (original === undefined) return { ok: false, error: { kind: 'malformed', message: 'rename record missing original path' } }; index += 1; entries.push({ ...entry(path, code[0] ?? ' ', code[1] ?? ' '), state: 'renamed', originalPath: original }); continue; } if (value.startsWith('u ')) { const fields = value.split(' '); const path = fields.slice(11).join(' '); entries.push({ ...entry(path, 'U', 'U'), state: 'conflicted', conflict: true, staged: true, unstaged: true }); continue; } if (value.startsWith('? ')) { entries.push({ ...entry(value.slice(2), '?', '?'), state: 'untracked', staged: false, unstaged: true, conflict: false }); continue; } if (value.startsWith('! ')) { entries.push({ ...entry(value.slice(2), '!', '!'), state: 'ignored', staged: false, unstaged: false, conflict: false }); continue; } return { ok: false, error: { kind: 'malformed', message: `unknown porcelain record ${value.slice(0, 2)}` } }; }
  return { ok: true, value: Object.freeze({ root, generation, entries: Object.freeze(entries), branch }) };
}

function entry(path: string, indexCode: string, worktreeCode: string): GitStatusEntry { const conflict = indexCode === 'U' || worktreeCode === 'U'; return Object.freeze({ path, state: stateFor(indexCode, worktreeCode), indexCode, worktreeCode, staged: indexCode !== ' ' && indexCode !== '?' && indexCode !== '!', unstaged: worktreeCode !== ' ' && worktreeCode !== '?' && worktreeCode !== '!', conflict }); }
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
