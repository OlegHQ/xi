import { CancellationSource } from '../../contracts/src/index';
import type { CancellationToken, FilesystemPort, ProcessPort, Result } from '../../contracts/src/index';

export type DiffLineKind = 'context' | 'added' | 'removed';
export interface DiffLine { readonly kind: DiffLineKind; readonly oldLine?: number; readonly newLine?: number; readonly text: string; }
export interface DiffHunk { readonly index: number; readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number; readonly firstLineIndex: number; }
export interface LineDiff { readonly lines: readonly DiffLine[]; readonly hunks: readonly DiffHunk[]; }

const CONTEXT_LINES = 3;
/** Bounded Myers budget: O(N*D) where D is the edit distance. Beyond this many diagonal
 * steps we bail out to a whole-file replace hunk rather than let a huge, near-unrelated
 * pair of files walk an unbounded edit graph on a keystroke-adjacent (albeit async) path. */
const MYERS_STEP_BUDGET = 200_000;

/** Splits text into lines, preserving each line's original trailing newline sequence (or
 * its absence on the last line) and any trailing '\r' as part of the line text, so CRLF and
 * missing-final-newline state survive unchanged into the rendered diff. */
function splitLinesPreserving(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Myers O(ND) shortest-edit-script diff over line arrays, bounded by `MYERS_STEP_BUDGET`. */
function myersDiff(oldLines: readonly string[], newLines: readonly string[]): { readonly ops: readonly ('equal' | 'delete' | 'insert')[]; readonly indices: readonly { old: number; next: number }[] } | undefined {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  if (max === 0) return { ops: [], indices: [] };
  const offset = max;
  const size = 2 * max + 1;
  const trace: Int32Array[] = [];
  let steps = 0;
  let vFinal: Int32Array | undefined;
  let dFinal = -1;
  let v = new Int32Array(size);
  v[offset + 1] = 0;
  outer: for (let d = 0; d <= max; d += 1) {
    const snapshot = v.slice();
    for (let k = -d; k <= d; k += 2) {
      steps += 1;
      if (steps > MYERS_STEP_BUDGET) return undefined;
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { trace.push(snapshot); vFinal = v.slice(); dFinal = d; break outer; }
    }
    trace.push(snapshot);
  }
  if (vFinal === undefined) return undefined;
  // Backtrack through the trace to recover the edit script.
  const ops: ('equal' | 'delete' | 'insert')[] = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d > 0; d -= 1) {
    const prevV = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (prevV[offset + k - 1] ?? 0) < (prevV[offset + k + 1] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = prevV[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('equal'); x -= 1; y -= 1; }
    if (x === prevX) { ops.push('insert'); y -= 1; } else { ops.push('delete'); x -= 1; }
  }
  while (x > 0 && y > 0) { ops.push('equal'); x -= 1; y -= 1; }
  while (x > 0) { ops.push('delete'); x -= 1; }
  while (y > 0) { ops.push('insert'); y -= 1; }
  ops.reverse();
  return { ops, indices: [] };
}

/** Pure line diff: Myers edit script within budget, else a whole-file replace fallback.
 * Produces context-trimmed hunks with `CONTEXT_LINES` of surrounding unchanged lines. */
export function computeLineDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiff {
  const script = myersDiff(oldLines, newLines);
  const rawLines: DiffLine[] = [];
  if (script === undefined) {
    // Budget exceeded: whole-file replace.
    for (let i = 0; i < oldLines.length; i += 1) rawLines.push({ kind: 'removed', oldLine: i + 1, text: oldLines[i]! });
    for (let i = 0; i < newLines.length; i += 1) rawLines.push({ kind: 'added', newLine: i + 1, text: newLines[i]! });
  } else {
    let oldIndex = 0;
    let newIndex = 0;
    for (const op of script.ops) {
      if (op === 'equal') { rawLines.push({ kind: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, text: oldLines[oldIndex]! }); oldIndex += 1; newIndex += 1; }
      else if (op === 'delete') { rawLines.push({ kind: 'removed', oldLine: oldIndex + 1, text: oldLines[oldIndex]! }); oldIndex += 1; }
      else { rawLines.push({ kind: 'added', newLine: newIndex + 1, text: newLines[newIndex]! }); newIndex += 1; }
    }
  }
  return trimToHunks(rawLines);
}

/** Collapses long unchanged runs to `CONTEXT_LINES` at each side of a change, grouping the
 * remainder into hunks with stable old/new start+count metadata. */
function trimToHunks(rawLines: readonly DiffLine[]): LineDiff {
  // Identify indices of changed lines to find hunk boundaries with context windows.
  const changedIndices: number[] = [];
  for (let i = 0; i < rawLines.length; i += 1) if (rawLines[i]!.kind !== 'context') changedIndices.push(i);
  if (changedIndices.length === 0) return { lines: [], hunks: [] };

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndices) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(rawLines.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const lines: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  let hunkIndex = 0;
  for (const range of ranges) {
    const slice = rawLines.slice(range.start, range.end + 1);
    const firstLineIndex = lines.length;
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const line of slice) {
      if (line.oldLine !== undefined && oldStart === 0) oldStart = line.oldLine;
      if (line.newLine !== undefined && newStart === 0) newStart = line.newLine;
      if (line.kind !== 'added') oldCount += 1;
      if (line.kind !== 'removed') newCount += 1;
      lines.push(line);
    }
    hunks.push({ index: hunkIndex, oldStart, oldCount, newStart, newCount, firstLineIndex });
    hunkIndex += 1;
  }
  return { lines: Object.freeze(lines), hunks: Object.freeze(hunks) };
}

export type GitDiffTarget = 'index' | 'worktree';
export type GitDiffSideKind = 'text' | 'binary' | 'missing' | 'unavailable';
export interface GitDiffSide { readonly kind: GitDiffSideKind; readonly lines?: readonly string[]; }
export interface GitDiffReady { readonly kind: 'ready'; readonly leftLabel: string; readonly rightLabel: string; readonly diff: LineDiff; }
export interface GitDiffBinary { readonly kind: 'binary'; readonly leftLabel: string; readonly rightLabel: string; }
export interface GitDiffUnavailable { readonly kind: 'unavailable'; readonly message: string; }
export type GitDiffResult = GitDiffReady | GitDiffBinary | GitDiffUnavailable;

const MAX_SIDE_BYTES = 4 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;

export interface GitDiffLoadOptions {
  readonly root: string;
  readonly relativePath: string;
  readonly target: GitDiffTarget;
  readonly cancellation?: CancellationToken;
}

export interface GitDiffServiceOptions {
  readonly process: ProcessPort;
  readonly filesystem: FilesystemPort;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
}

function looksBinary(bytes: Uint8Array): boolean {
  const scanLength = Math.min(bytes.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < scanLength; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Loads the two sides of a Git diff (`index`: HEAD vs INDEX; `worktree`: INDEX vs WORKTREE)
 * strictly from disk/git object store -- never from an open editor buffer -- and computes the
 * line diff between them via `computeLineDiff`. Labels are exactly BASE/INDEX/WORKTREE.
 */
export class GitDiffService {
  readonly #process: ProcessPort;
  readonly #filesystem: FilesystemPort;
  readonly #env: Readonly<Record<string, string>>;
  readonly #timeoutMilliseconds: number;

  constructor(options: GitDiffServiceOptions) {
    this.#process = options.process;
    this.#filesystem = options.filesystem;
    this.#env = options.env ?? {};
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  }

  async load(options: GitDiffLoadOptions): Promise<Result<GitDiffResult, { readonly message: string }>> {
    const cancellation = options.cancellation ?? new CancellationSource().token;
    const leftLabel = options.target === 'index' ? 'BASE' : 'INDEX';
    const rightLabel = options.target === 'index' ? 'INDEX' : 'WORKTREE';
    const [left, right] = await Promise.all([
      options.target === 'index' ? this.#readGitObject(options.root, `HEAD:${options.relativePath}`, cancellation) : this.#readGitObject(options.root, `:${options.relativePath}`, cancellation),
      options.target === 'index' ? this.#readGitObject(options.root, `:${options.relativePath}`, cancellation) : this.#readWorktreeFile(options.root, options.relativePath, cancellation),
    ]);
    if (cancellation.isCancelled) return { ok: false, error: { message: 'cancelled' } };
    if (left.kind === 'unavailable' || right.kind === 'unavailable') {
      return { ok: true, value: { kind: 'unavailable', message: 'diff side exceeds the size limit or could not be read' } };
    }
    if (left.kind === 'binary' || right.kind === 'binary') {
      return { ok: true, value: { kind: 'binary', leftLabel, rightLabel } };
    }
    const oldLines = left.kind === 'missing' ? [] : left.lines ?? [];
    const newLines = right.kind === 'missing' ? [] : right.lines ?? [];
    const diff = computeLineDiff(oldLines, newLines);
    return { ok: true, value: { kind: 'ready', leftLabel, rightLabel, diff } };
  }

  async #readGitObject(root: string, spec: string, cancellation: CancellationToken): Promise<GitDiffSide> {
    const spawned = await this.#process.spawn({
      argv: ['git', 'show', spec],
      cwd: root,
      env: this.#env,
      stdin: 'ignore',
      timeoutMilliseconds: this.#timeoutMilliseconds,
      cancellation,
    });
    if (!spawned.ok) return { kind: 'missing' };
    const handle = spawned.value;
    try {
      const [bytes, exit] = await Promise.all([drain(handle.stdout, MAX_SIDE_BYTES), handle.exit]);
      if (!exit.ok || exit.value.code !== 0) return { kind: 'missing' };
      if (!bytes.ok) return bytes.error === 'limit' ? { kind: 'unavailable' } : { kind: 'missing' };
      if (looksBinary(bytes.value)) return { kind: 'binary' };
      return { kind: 'text', lines: splitLinesPreserving(new TextDecoder('utf-8').decode(bytes.value)) };
    } finally {
      try { handle.dispose(); } catch { /* process exit owns final cleanup */ }
    }
  }

  async #readWorktreeFile(root: string, relativePath: string, cancellation: CancellationToken): Promise<GitDiffSide> {
    const absolute = `${root}/${relativePath}`;
    const read = await this.#filesystem.readFile(absolute, cancellation, { maxBytes: MAX_SIDE_BYTES });
    if (!read.ok) {
      return read.error.code === 'file-too-large' ? { kind: 'unavailable' } : { kind: 'missing' };
    }
    if (looksBinary(read.value)) return { kind: 'binary' };
    return { kind: 'text', lines: splitLinesPreserving(new TextDecoder('utf-8').decode(read.value)) };
  }
}

async function drain(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Result<Uint8Array, 'limit' | 'error'>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > limit) return { ok: false, error: 'limit' };
      chunks.push(chunk);
    }
  } catch { return { ok: false, error: 'error' }; }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, value: output };
}
