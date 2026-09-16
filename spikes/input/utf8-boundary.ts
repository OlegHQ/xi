import { Buffer } from "node:buffer";
import { Transform, type TransformCallback } from "node:stream";

const replacement = Uint8Array.of(0xef, 0xbf, 0xbd);

/**
 * Keeps a valid UTF-8 code point together when a terminal stream splits it
 * across chunks. It has no wall-clock timeout: bytes in a text code point are
 * not Escape-sequence ambiguity. Invalid input becomes U+FFFD so malformed
 * high bytes cannot turn into legacy Alt commands.
 */
export class Utf8ChunkAccumulator {
  #pending: number[] = [];
  #expectedLength = 0;

  push(chunk: Uint8Array): Uint8Array {
    const output: number[] = [];
    let index = 0;
    while (index < chunk.length) {
      const byte = chunk[index];
      if (byte === undefined) break;

      if (this.#pending.length > 0) {
        if (this.acceptsContinuation(byte)) {
          this.#pending.push(byte);
          index += 1;
          if (this.#pending.length === this.#expectedLength) {
            output.push(...this.#pending);
            this.clearPending();
          }
          continue;
        }
        output.push(...replacement);
        this.clearPending();
        // Reprocess this byte: it may begin another code point or be ASCII.
        continue;
      }

      if (byte <= 0x7f) {
        output.push(byte);
        index += 1;
        continue;
      }

      const length = validLeadLength(byte);
      if (length === 1) {
        output.push(...replacement);
        index += 1;
        continue;
      }
      this.#pending = [byte];
      this.#expectedLength = length;
      index += 1;
    }
    return Uint8Array.from(output);
  }

  finish(): Uint8Array {
    if (this.#pending.length === 0) return new Uint8Array();
    this.clearPending();
    return Uint8Array.from(replacement);
  }

  reset(): void {
    this.clearPending();
  }

  private acceptsContinuation(byte: number): boolean {
    if (byte < 0x80 || byte > 0xbf) return false;
    if (this.#pending.length !== 1) return true;
    const lead = this.#pending[0];
    if (lead === undefined) return false;
    if (lead === 0xe0 && byte < 0xa0) return false;
    if (lead === 0xed && byte > 0x9f) return false;
    if (lead === 0xf0 && byte < 0x90) return false;
    if (lead === 0xf4 && byte > 0x8f) return false;
    return true;
  }

  private clearPending(): void {
    this.#pending = [];
    this.#expectedLength = 0;
  }
}

/** Spike-only adapter around a TTY ReadStream for the public OpenTUI stdin port. */
export class Utf8TerminalInput extends Transform {
  readonly #source: NodeJS.ReadStream;
  readonly #accumulator = new Utf8ChunkAccumulator();
  #disposed = false;

  constructor(source: NodeJS.ReadStream) {
    super({ readableObjectMode: false, writableObjectMode: false });
    this.#source = source;
    Object.defineProperties(this, {
      isTTY: { enumerable: true, get: () => source.isTTY },
      isRaw: { enumerable: true, get: () => source.isRaw },
    });
    source.pipe(this);
  }

  setRawMode(mode: boolean): this {
    this.#source.setRawMode(mode);
    return this;
  }

  /** The cast is limited to OpenTUI's declared stdin port; stream and TTY operations are forwarded. */
  asOpenTuiReadStream(): NodeJS.ReadStream {
    return this as unknown as NodeJS.ReadStream;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.unpipe(this);
    this.#accumulator.reset();
    this.destroy();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
      const normalized = this.#accumulator.push(bytes);
      callback(null, Buffer.from(normalized));
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(null, Buffer.from(this.#accumulator.finish()));
  }
}

function validLeadLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}
