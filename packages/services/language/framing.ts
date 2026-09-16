import type { Message } from 'vscode-jsonrpc/browser';

export type FrameFailureKind =
  | 'header-too-large'
  | 'malformed-header'
  | 'missing-content-length'
  | 'duplicate-content-length'
  | 'invalid-content-length'
  | 'frame-too-large'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'invalid-jsonrpc-message'
  | 'eof-mid-header'
  | 'eof-mid-body';

export class FrameProtocolError extends Error {
  constructor(readonly kind: FrameFailureKind, message: string) {
    super(message);
    this.name = 'FrameProtocolError';
  }
}

export interface FrameDecoderLimits {
  readonly maxHeaderBytes: number;
  readonly maxBodyBytes: number;
}

const HEADER_END = [0x0d, 0x0a, 0x0d, 0x0a] as const;
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const FRAME_HARD_LIMITS = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxBodyBytes: 64 * 1024 * 1024,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function validateMessage(value: unknown): Message {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new FrameProtocolError('invalid-jsonrpc-message', 'JSON-RPC message must be an object with jsonrpc "2.0"');
  }

  const hasMethod = Object.hasOwn(value, 'method');
  const hasId = Object.hasOwn(value, 'id');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');

  if (hasMethod) {
    if (typeof value.method !== 'string' || value.method.length === 0 || hasResult || hasError) {
      throw new FrameProtocolError('invalid-jsonrpc-message', 'JSON-RPC requests and notifications require a method string');
    }
    if (hasId && !isId(value.id)) {
      throw new FrameProtocolError('invalid-jsonrpc-message', 'JSON-RPC request IDs must be strings or safe integers');
    }
    return value as unknown as Message;
  }

  if (!hasId || !isId(value.id) || hasResult === hasError) {
    throw new FrameProtocolError('invalid-jsonrpc-message', 'JSON-RPC responses require an ID and exactly one of result or error');
  }
  if (hasError) {
    if (!isRecord(value.error) || typeof value.error.code !== 'number' || typeof value.error.message !== 'string') {
      throw new FrameProtocolError('invalid-jsonrpc-message', 'JSON-RPC response error must contain numeric code and string message');
    }
  }
  return value as unknown as Message;
}

/** Incrementally decodes bounded LSP Content-Length frames from arbitrary byte chunks. */
export class ContentLengthFrameDecoder {
  private readonly header: Uint8Array;
  private headerLength = 0;
  private body: Uint8Array | undefined;
  private bodyLength = 0;
  private bodyOffset = 0;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  private ended = false;

  readonly limits: FrameDecoderLimits;

  constructor(limits: Partial<FrameDecoderLimits> = {}) {
    const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    const maxBodyBytes = limits.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < HEADER_END.length
      || maxHeaderBytes > FRAME_HARD_LIMITS.maxHeaderBytes
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > FRAME_HARD_LIMITS.maxBodyBytes) {
      throw new RangeError('LSP frame limits must be positive safe integers');
    }
    this.limits = Object.freeze({ maxHeaderBytes, maxBodyBytes });
    this.header = new Uint8Array(maxHeaderBytes);
  }

  feed(chunk: Uint8Array): readonly Message[] {
    const messages: Message[] = [];
    this.feedEach(chunk, (message) => messages.push(message));
    return messages;
  }

  /** Deliver each completed frame immediately so a coalesced chunk is not retained as a message array. */
  feedEach(chunk: Uint8Array, onMessage: (message: Message) => void): void {
    if (this.ended) throw new FrameProtocolError('malformed-header', 'bytes received after the frame stream ended');
    let inputOffset = 0;

    while (inputOffset < chunk.length) {
      if (this.body === undefined) {
        let headerComplete = false;
        while (inputOffset < chunk.length) {
          if (this.headerLength >= this.limits.maxHeaderBytes) {
            throw new FrameProtocolError('header-too-large', `LSP header exceeds ${this.limits.maxHeaderBytes} bytes`);
          }
          this.header[this.headerLength] = chunk[inputOffset] ?? 0;
          this.headerLength += 1;
          inputOffset += 1;
          if (this.headerLength >= HEADER_END.length
            && this.header[this.headerLength - 4] === HEADER_END[0]
            && this.header[this.headerLength - 3] === HEADER_END[1]
            && this.header[this.headerLength - 2] === HEADER_END[2]
            && this.header[this.headerLength - 1] === HEADER_END[3]) {
            this.bodyLength = this.parseContentLength(this.header.subarray(0, this.headerLength - HEADER_END.length));
            this.headerLength = 0;
            this.body = new Uint8Array(this.bodyLength);
            this.bodyOffset = 0;
            headerComplete = true;
            if (this.bodyLength === 0) {
              onMessage(this.decodeBody(this.body));
              this.body = undefined;
            }
            break;
          }
        }
        if (!headerComplete) return;
      }

      const activeBody = this.body;
      if (activeBody === undefined) continue;
      const bytesNeeded = this.bodyLength - this.bodyOffset;
      const bytesAvailable = chunk.length - inputOffset;
      const copied = Math.min(bytesNeeded, bytesAvailable);
      activeBody.set(chunk.subarray(inputOffset, inputOffset + copied), this.bodyOffset);
      inputOffset += copied;
      this.bodyOffset += copied;
      if (this.bodyOffset === this.bodyLength) {
        onMessage(this.decodeBody(activeBody));
        this.body = undefined;
        this.bodyLength = 0;
        this.bodyOffset = 0;
      }
    }

  }

  finish(): void {
    this.ended = true;
    if (this.body !== undefined) {
      throw new FrameProtocolError('eof-mid-body', `LSP stream ended after ${this.bodyOffset} of ${this.bodyLength} body bytes`);
    }
    if (this.headerLength !== 0) {
      throw new FrameProtocolError('eof-mid-header', 'LSP stream ended before a complete Content-Length header');
    }
  }

  private parseContentLength(headerBytes: Uint8Array): number {
    let headerText = '';
    for (const byte of headerBytes) {
      if (byte > 0x7f) throw new FrameProtocolError('malformed-header', 'LSP headers must be ASCII');
      headerText += String.fromCharCode(byte);
    }
    const lines = headerText.split('\r\n');
    let lengthValue: string | undefined;
    const seenHeaders = new Set<string>();
    for (const line of lines) {
      if (line.length === 0) throw new FrameProtocolError('malformed-header', 'LSP headers cannot contain empty fields');
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/u.exec(line);
      if (!match) throw new FrameProtocolError('malformed-header', 'LSP header field is malformed');
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined) throw new FrameProtocolError('malformed-header', 'LSP header field is incomplete');
      const normalizedKey = key.toLowerCase();
      if (seenHeaders.has(normalizedKey)) {
        if (normalizedKey === 'content-length') {
          throw new FrameProtocolError('duplicate-content-length', 'LSP frame has duplicate Content-Length fields');
        }
        throw new FrameProtocolError('malformed-header', `LSP frame has duplicate ${key} fields`);
      }
      seenHeaders.add(normalizedKey);
      if (normalizedKey === 'content-length') lengthValue = value.trim();
    }
    if (lengthValue === undefined) throw new FrameProtocolError('missing-content-length', 'LSP frame is missing Content-Length');
    if (!/^(0|[1-9][0-9]*)$/u.test(lengthValue)) {
      throw new FrameProtocolError('invalid-content-length', 'Content-Length must be a non-negative decimal integer');
    }
    const length = Number(lengthValue);
    if (!Number.isSafeInteger(length)) throw new FrameProtocolError('invalid-content-length', 'Content-Length is outside the safe integer range');
    if (length > this.limits.maxBodyBytes) {
      throw new FrameProtocolError('frame-too-large', `LSP body exceeds ${this.limits.maxBodyBytes} bytes`);
    }
    return length;
  }

  private decodeBody(body: Uint8Array): Message {
    let text: string;
    try {
      text = this.utf8.decode(body);
    } catch {
      throw new FrameProtocolError('invalid-utf8', 'LSP body is not valid UTF-8');
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new FrameProtocolError('invalid-json', 'LSP body is not valid JSON');
    }
    return validateMessage(value);
  }
}

export function encodeContentLengthFrame(body: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}
