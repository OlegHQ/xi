import { CancellationSource } from '../../contracts/src/index';
import type {
  CancellationToken,
  Disposable,
  PlatformFailure,
  ProcessPort,
  Result,
} from '../../contracts/src/index';

export interface FormatRange {
  readonly start: number;
  readonly end: number;
}

export interface FormatDocument {
  readonly documentId: string;
  readonly version: number;
  readonly text: string;
  readonly path: string;
  readonly range?: FormatRange;
}

export interface FormatterEdit {
  /** UTF-16 half-open offsets in the captured FormatDocument. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type FormatterFailure = {
  readonly kind: 'failed' | 'stale' | 'unstable' | 'disposed' | 'cancelled' | 'timeout' | 'output-limit';
  readonly message: string;
};

export interface FormatterSpec {
  readonly id: string;
  readonly run: (input: FormatDocument, cancellation?: CancellationToken) => Promise<Result<string, FormatterFailure>>;
}

export interface LspFormatterProvider {
  readonly format: (input: FormatDocument, cancellation: CancellationToken) => Promise<Result<readonly FormatterEdit[], FormatterFailure>>;
}

export interface ExternalFormatterOptions {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly process: ProcessPort;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const NEVER_CANCELLED: CancellationToken = Object.freeze({
  isCancelled: false,
  onCancel: () => ({ dispose: () => {} }),
});

/** Runs ordered formatter stages over an immutable snapshot and rejects stale output. */
export class FormatterPipeline implements Disposable {
  readonly #formatters: readonly FormatterSpec[];
  #disposed = false;

  constructor(formatters: readonly FormatterSpec[]) {
    this.#formatters = Object.freeze([...formatters]);
  }

  async format(
    document: FormatDocument,
    currentVersion: () => number,
    cancellation: CancellationToken = NEVER_CANCELLED,
  ): Promise<Result<FormatResult, FormatterFailure>> {
    if (this.#disposed) return failure('disposed', 'formatter pipeline is disposed');
    let text = document.text;
    const ids: string[] = [];
    for (const formatter of this.#formatters) {
      if (cancellation.isCancelled) return failure('cancelled', 'formatting was cancelled');
      if (currentVersion() !== document.version) return failure('stale', 'document changed during formatting');
      const result = await formatter.run({ ...document, text }, cancellation);
      if (!result.ok) return result;
      text = result.value;
      ids.push(formatter.id);
    }
    if (cancellation.isCancelled) return failure('cancelled', 'formatting was cancelled');
    if (currentVersion() !== document.version) return failure('stale', 'document changed before format apply');
    return {
      ok: true,
      value: Object.freeze({
        documentId: document.documentId,
        expectedVersion: document.version,
        text,
        changed: text !== document.text,
        formatterIds: Object.freeze(ids),
      }),
    };
  }

  async formatTwiceStable(
    document: FormatDocument,
    currentVersion: () => number,
    cancellation: CancellationToken = NEVER_CANCELLED,
  ): Promise<Result<FormatResult, FormatterFailure>> {
    const first = await this.format(document, currentVersion, cancellation);
    if (!first.ok) return first;
    const second = await this.format({ ...document, text: first.value.text }, currentVersion, cancellation);
    if (!second.ok) return second;
    if (second.value.text !== first.value.text) return failure('unstable', 'formatter output is not stable after two passes');
    return first;
  }

  dispose(): void {
    this.#disposed = true;
  }
}

export interface FormatResult {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly text: string;
  readonly changed: boolean;
  readonly formatterIds: readonly string[];
}

/** Adapt an LSP/range formatter's versioned edits into the ordered text pipeline. */
export function createLspFormatter(id: string, provider: LspFormatterProvider): FormatterSpec {
  return {
    id,
    run: async (input, cancellation = NEVER_CANCELLED) => {
      const result = await provider.format(input, cancellation);
      if (!result.ok) return result;
      return applyFormatterEdits(input.text, result.value);
    },
  };
}

/** Create a process-backed formatter. Commands receive argv values and never shell text. */
export function createExternalFormatter(options: ExternalFormatterOptions): FormatterSpec {
  const args = Object.freeze([...(options.args ?? [])]);
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    id: options.id,
    run: async (input, cancellation = NEVER_CANCELLED) => {
      if (options.command.trim().length === 0) return failure('failed', 'formatter command is empty');
      if (!validLimit(timeoutMilliseconds) || !validLimit(maxOutputBytes)) return failure('failed', 'formatter limits are invalid');
      if (cancellation.isCancelled) return failure('cancelled', 'formatting was cancelled');
      const localCancellation = new CancellationSource();
      const subscription = cancellation.onCancel(() => localCancellation.cancel());
      const timeout = setTimeout(() => localCancellation.cancel(), timeoutMilliseconds);
      let spawned: Result<import('../../contracts/src/index').ProcessHandle, PlatformFailure>;
      try {
        spawned = await options.process.spawn({
          argv: [options.command, ...args.map((arg) => arg === '{file}' ? input.path : arg)] as [string, ...string[]],
          cwd: options.cwd,
          env: options.env,
          stdin: 'pipe',
          timeoutMilliseconds,
          cancellation: localCancellation.token,
        });
      } catch (error: unknown) {
        subscription.dispose();
        localCancellation.dispose();
        return failure('failed', error instanceof Error ? error.message : 'formatter process failed to start');
      }
      if (!spawned.ok) {
        subscription.dispose();
        localCancellation.dispose();
        return failure('failed', spawned.error.message);
      }
      const handle = spawned.value;
      try {
        if (handle.stdin === null) return failure('failed', 'formatter process has no stdin pipe');
        const stdin = handle.stdin;
        // Write stdin concurrently with draining stdout/stderr, not before: a streaming
        // formatter can start writing output before it has consumed all of its input, and its
        // stdout pipe has a bounded OS buffer. Awaiting the full stdin write (and close) before
        // ever reading stdout deadlocks once that buffer fills -- the formatter blocks writing
        // output nobody is draining yet, while this call blocks writing input it is not
        // consuming.
        const stdinTask = (async (): Promise<Result<void, PlatformFailure>> => {
          const written = await stdin.write(new TextEncoder().encode(input.text));
          if (!written.ok) return written;
          return stdin.close();
        })();
        const [stdinResult, stdout, stderr, exit] = await Promise.all([
          stdinTask,
          readOutput(handle.stdout, maxOutputBytes),
          readOutput(handle.stderr, maxOutputBytes),
          handle.exit,
        ]);
        if (cancellation.isCancelled) return failure('cancelled', 'formatting was cancelled');
        if (!stdinResult.ok) return failure('failed', stdinResult.error.message);
        if (!stdout.ok) {
          localCancellation.cancel();
          return stdout.error.kind === 'output-limit' ? stdout : failure('failed', stdout.error.message);
        }
        if (!stderr.ok) {
          localCancellation.cancel();
          return stderr.error.kind === 'output-limit' ? stderr : failure('failed', stderr.error.message);
        }
        if (!exit.ok) return failure('failed', exit.error.message);
        if (exit.value.code !== 0 || exit.value.signal !== null) {
          const detail = decodeOutput(stderr.value);
          const message = detail.ok && detail.value.length > 0 ? detail.value : `formatter exited with code ${exit.value.code ?? 'unknown'}`;
          return failure(exit.value.signal !== null && localCancellation.token.isCancelled ? 'timeout' : 'failed', message);
        }
        const decoded = decodeOutput(stdout.value);
        if (!decoded.ok) return decoded;
        return decoded.value.length === 0 && input.text.length > 0
          ? failure('failed', 'formatter returned no document output')
          : decoded;
      } finally {
        clearTimeout(timeout);
        subscription.dispose();
        localCancellation.dispose();
        try { handle.dispose(); } catch { /* process exit owns final cleanup */ }
      }
    },
  };
}

function applyFormatterEdits(text: string, edits: readonly FormatterEdit[]): Result<string, FormatterFailure> {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let previousEnd = 0;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > text.length || edit.start < previousEnd) {
      return failure('failed', 'formatter returned invalid or overlapping UTF-16 edits');
    }
    if (!isUtf16Boundary(text, edit.start) || !isUtf16Boundary(text, edit.end) || hasUnpairedSurrogate(edit.text)) {
      return failure('failed', 'formatter returned an invalid UTF-16 range or replacement');
    }
    previousEnd = edit.end;
  }
  let output = text;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index];
    if (edit === undefined) continue;
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return { ok: true, value: output };
}

async function readOutput(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Result<Uint8Array, FormatterFailure>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) return failure('failed', 'formatter output was not bytes');
      size += chunk.byteLength;
      if (size > limit) return failure('output-limit', `formatter output exceeded ${limit} bytes`);
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    return failure('failed', error instanceof Error ? error.message : 'formatter output could not be read');
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: output };
}

function decodeOutput(bytes: Uint8Array): Result<string, FormatterFailure> {
  try { return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return failure('failed', 'formatter returned invalid UTF-8 output'); }
}

function validLimit(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function failure(kind: FormatterFailure['kind'], message: string): Result<never, FormatterFailure> {
  return { ok: false, error: { kind, message } };
}
