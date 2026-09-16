import { StdinParser, type StdinEvent } from '@opentui/core/renderer';
import type { CanonicalInputEvent, Disposable } from '../../contracts/src/index.ts';

export interface InputAdapterOptions {
  readonly timeoutMilliseconds?: number;
  readonly kittyKeyboard?: boolean;
}

export type InputAdapterRecord =
  | {
      readonly kind: 'event';
      readonly event: CanonicalInputEvent;
      readonly rawBytes: Uint8Array;
      readonly rawHex: string;
    }
  | {
      readonly kind: 'protocol';
      readonly protocol: string;
      readonly rawBytes: Uint8Array;
      readonly rawHex: string;
    };

export type InputAdapterListener = (record: InputAdapterRecord) => void;

/**
 * Guards UTF-8 text before OpenTUI's Escape timeout sees it. The parser still
 * owns terminal protocol decoding, while this small boundary prevents a split
 * text scalar from becoming an Alt sequence after the parser deadline.
 */
export class Utf8InputGuard {
  #pending: number[] = [];
  #expectedLength = 0;

  push(bytes: Uint8Array): Uint8Array {
    const output: number[] = [];
    for (let index = 0; index < bytes.length;) {
      const byte = bytes[index];
      if (byte === undefined) break;
      if (this.#pending.length > 0) {
        if (this.acceptsContinuation(byte)) {
          this.#pending.push(byte);
          index += 1;
          if (this.#pending.length === this.#expectedLength) {
            output.push(...this.#pending);
            this.clear();
          }
          continue;
        }
        output.push(0xef, 0xbf, 0xbd);
        this.clear();
        continue;
      }
      if (byte <= 0x7f) {
        output.push(byte);
        index += 1;
        continue;
      }
      const length = utf8LeadLength(byte);
      if (length === 1) {
        output.push(0xef, 0xbf, 0xbd);
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
    this.clear();
    return Uint8Array.of(0xef, 0xbf, 0xbd);
  }

  reset(): void { this.clear(); }

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

  private clear(): void {
    this.#pending = [];
    this.#expectedLength = 0;
  }
}

/**
 * Production input boundary for the OpenTUI parser. Each parser event is
 * converted once, and subscribers receive the same immutable record exactly
 * once. `rawBytes` is retained for byte-faithful SGR/X10 diagnostics.
 */
export class CanonicalInputAdapter implements Disposable {
  readonly #parser: StdinParser;
  readonly #guard = new Utf8InputGuard();
  readonly #listeners = new Set<InputAdapterListener>();
  #escapeCandidate: number[] = [];
  #x10Payload: number[] = [];
  #x10Active = false;
  #disposed = false;

  constructor(options: InputAdapterOptions = {}) {
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 20;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 0) {
      throw new TypeError('input timeout must be a nonnegative safe integer');
    }
    this.#parser = new StdinParser({
      timeoutMs: timeoutMilliseconds,
      armTimeouts: false,
      useKittyKeyboard: options.kittyKeyboard === true,
      protocolContext: { kittyKeyboardEnabled: options.kittyKeyboard === true },
    });
  }

  subscribe(listener: InputAdapterListener): Disposable {
    if (this.#disposed) throw new Error('input-adapter-disposed');
    this.#listeners.add(listener);
    let active = true;
    return Object.freeze({
      dispose: (): void => {
        if (!active) return;
        active = false;
        this.#listeners.delete(listener);
      },
    });
  }

  /** Push one terminal read and return the records emitted by that read. */
  push(bytes: Uint8Array): readonly InputAdapterRecord[] {
    if (this.#disposed) return Object.freeze([]);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('input bytes must be Uint8Array');
    this.feedBytes(new Uint8Array(bytes));
    return this.drainParser();
  }

  /** Resolve an Escape sequence timeout without flushing a pending UTF-8 scalar. */
  flushTimeout(nowMilliseconds = Number.MAX_SAFE_INTEGER): readonly InputAdapterRecord[] {
    if (this.#disposed) return Object.freeze([]);
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) throw new TypeError('timeout clock must be nonnegative');
    this.flushProtocolCandidate();
    this.#parser.flushTimeout(nowMilliseconds);
    return this.drainParser();
  }

  /** Flush an incomplete scalar as replacement text, then resolve parser input. */
  finish(): readonly InputAdapterRecord[] {
    if (this.#disposed) return Object.freeze([]);
    this.flushProtocolCandidate();
    const trailing = this.#guard.finish();
    if (trailing.length > 0) this.#parser.push(trailing);
    this.#parser.flushTimeout(Number.MAX_SAFE_INTEGER);
    return this.drainParser();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#guard.reset();
    this.#escapeCandidate = [];
    this.#x10Payload = [];
    this.#x10Active = false;
    this.#parser.destroy();
    this.#listeners.clear();
  }

  private drainParser(): readonly InputAdapterRecord[] {
    const emitted: InputAdapterRecord[] = [];
    this.#parser.drain((event) => {
      const record = adaptStdinEvent(event);
      emitted.push(record);
      for (const listener of [...this.#listeners]) listener(record);
    });
    return Object.freeze(emitted);
  }

  private feedBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.#x10Active) {
        this.#x10Payload.push(byte);
        if (this.#x10Payload.length === 3) {
          this.#parser.push(Uint8Array.from([0x1b, 0x5b, 0x4d, ...this.#x10Payload]));
          this.#x10Payload = [];
          this.#x10Active = false;
        }
        continue;
      }
      if (this.#escapeCandidate.length === 0) {
        if (byte === 0x1b) this.#escapeCandidate = [byte];
        else this.feedGuard(Uint8Array.of(byte));
        continue;
      }
      if (this.#escapeCandidate.length === 1) {
        if (byte === 0x5b) this.#escapeCandidate.push(byte);
        else {
          this.feedGuard(Uint8Array.from(this.#escapeCandidate));
          this.#escapeCandidate = [];
          this.feedBytes(Uint8Array.of(byte));
        }
        continue;
      }
      if (byte === 0x4d) {
        this.#x10Payload = [];
        this.#x10Active = true;
        this.#escapeCandidate = [];
      } else {
        this.feedGuard(Uint8Array.from(this.#escapeCandidate));
        this.#escapeCandidate = [];
        this.feedBytes(Uint8Array.of(byte));
      }
    }
  }

  private flushProtocolCandidate(): void {
    if (this.#x10Active) {
      this.#parser.push(Uint8Array.from([0x1b, 0x5b, 0x4d, ...this.#x10Payload]));
      this.#x10Payload = [];
      this.#x10Active = false;
    }
    if (this.#escapeCandidate.length > 0) {
      this.feedGuard(Uint8Array.from(this.#escapeCandidate));
      this.#escapeCandidate = [];
    }
  }

  private feedGuard(bytes: Uint8Array): void {
    const guarded = this.#guard.push(bytes);
    if (guarded.length > 0) this.#parser.push(guarded);
  }
}

function adaptStdinEvent(event: StdinEvent): InputAdapterRecord {
  switch (event.type) {
    case 'key': {
      const rawBytes = encodeText(event.raw);
      const key: Extract<CanonicalInputEvent, { readonly kind: 'key' }> = Object.freeze({
        kind: 'key',
        key: event.key.name.length > 0 ? event.key.name : '\uFFFD',
        phase: event.key.eventType,
        modifiers: Object.freeze({
          shift: event.key.shift,
          alt: event.key.meta || event.key.option,
          ctrl: event.key.ctrl,
          meta: event.key.meta,
        }),
        rawBytes: new Uint8Array(rawBytes),
      });
      return Object.freeze({ kind: 'event', event: key, rawBytes: new Uint8Array(rawBytes), rawHex: bytesToHex(rawBytes) });
    }
    case 'paste': {
      const rawBytes = new Uint8Array(event.bytes);
      const paste: Extract<CanonicalInputEvent, { readonly kind: 'paste' }> = Object.freeze({
        kind: 'paste',
        bytes: new Uint8Array(event.bytes),
      });
      return Object.freeze({ kind: 'event', event: paste, rawBytes, rawHex: bytesToHex(rawBytes) });
    }
    case 'mouse': {
      // OpenTUI's parser exposes X10's byte-string carrier as a JS string.
      // Code-unit conversion is intentional: UTF-8 re-encoding would change
      // high-bit X10 coordinates and invalidate the reproduction trace.
      const rawBytes = byteStringToBytes(event.raw);
      const phase = mousePhase(event.event.type);
      const wheelDelta = event.event.scroll === undefined
        ? 0
        : (event.event.scroll.direction === 'up' || event.event.scroll.direction === 'left'
          ? -event.event.scroll.delta : event.event.scroll.delta);
      const pointer: Extract<CanonicalInputEvent, { readonly kind: 'pointer' }> = Object.freeze({
        kind: 'pointer',
        phase,
        cell: Object.freeze({ column0: event.event.x, row0: event.event.y }),
        button: event.event.button,
        modifiers: Object.freeze({ shift: event.event.modifiers.shift, alt: event.event.modifiers.alt, ctrl: event.event.modifiers.ctrl, meta: false }),
        wheelDelta,
      });
      return Object.freeze({ kind: 'event', event: pointer, rawBytes, rawHex: bytesToHex(rawBytes) });
    }
    case 'response': {
      const rawBytes = byteStringToBytes(event.sequence);
      return Object.freeze({ kind: 'protocol', protocol: event.protocol, rawBytes, rawHex: bytesToHex(rawBytes) });
    }
    default:
      return assertNever(event);
  }
}

function mousePhase(type: string): Extract<CanonicalInputEvent, { readonly kind: 'pointer' }>['phase'] {
  if (type === 'scroll') return 'wheel';
  if (type === 'drag-end' || type === 'drop') return 'up';
  if (type === 'over' || type === 'out') return 'move';
  if (type === 'down' || type === 'up' || type === 'move' || type === 'drag') return type;
  return 'move';
}

function utf8LeadLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

function encodeText(value: string): Uint8Array { return new TextEncoder().encode(value); }

function byteStringToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = (value.charCodeAt(index) ?? 0) & 0xff;
  return output;
}

const hexDecoder = new TextDecoder();
function bytesToHex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef';
  const output = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    output[index * 2] = digits.charCodeAt(byte >>> 4);
    output[index * 2 + 1] = digits.charCodeAt(byte & 0x0f);
  }
  return hexDecoder.decode(output);
}

function assertNever(value: never): never { throw new Error(`unsupported OpenTUI event: ${JSON.stringify(value)}`); }
