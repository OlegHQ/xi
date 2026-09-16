import type {
  KeyEvent,
  MouseEvent,
  PasteEvent,
  ParsedKey,
  RawMouseEvent,
  ScrollInfo,
  StdinEvent,
} from "@opentui/core";
import { Buffer } from "node:buffer";

export type CanonicalKeyEvent = {
  readonly kind: "key";
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly option: boolean;
  readonly eventType: ParsedKey["eventType"];
  readonly source: ParsedKey["source"];
  readonly rawHex: string;
  readonly number: boolean;
  readonly code?: string;
  readonly super?: boolean;
  readonly hyper?: boolean;
  readonly capsLock?: boolean;
  readonly numLock?: boolean;
  readonly baseCode?: number;
  readonly repeated?: boolean;
};

export type CanonicalPasteEvent = {
  readonly kind: "paste";
  readonly payloadHex: string;
  readonly length: number;
  readonly mimeType?: string;
  readonly pasteKind?: "text" | "binary" | "unknown";
};

export type CanonicalFocusEvent = {
  readonly kind: "focus" | "blur";
  readonly rawHex?: string;
};

export type CanonicalMouseEvent = {
  readonly kind: "mouse";
  readonly eventType: RawMouseEvent["type"];
  readonly button: number;
  /** Zero-based terminal cell column. */
  readonly column0: number;
  /** Zero-based terminal cell row. */
  readonly row0: number;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly source: "stdin-parser" | "renderer";
  readonly encoding?: "sgr" | "x10";
  readonly rawHex?: string;
  readonly scroll?: ScrollInfo;
};

export type CanonicalResponseEvent = {
  readonly kind: "response";
  readonly protocol: string;
  readonly sequenceHex: string;
};

export type CanonicalInputEvent =
  | CanonicalKeyEvent
  | CanonicalPasteEvent
  | CanonicalFocusEvent
  | CanonicalMouseEvent
  | CanonicalResponseEvent;

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function keyEvent(key: ParsedKey, raw: string): CanonicalKeyEvent {
  const normalized: CanonicalKeyEvent = {
    kind: "key",
    name: key.name,
    sequence: key.sequence,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    option: key.option,
    eventType: key.repeated === true && key.eventType === "press" ? "repeat" : key.eventType,
    source: key.source,
    rawHex: bytesToHex(Buffer.from(raw, "utf8")),
    number: key.number,
    ...(key.code === undefined ? {} : { code: key.code }),
    ...(key.super === undefined ? {} : { super: key.super }),
    ...(key.hyper === undefined ? {} : { hyper: key.hyper }),
    ...(key.capsLock === undefined ? {} : { capsLock: key.capsLock }),
    ...(key.numLock === undefined ? {} : { numLock: key.numLock }),
    ...(key.baseCode === undefined ? {} : { baseCode: key.baseCode }),
    ...(key.repeated === undefined ? {} : { repeated: key.repeated }),
  };
  return normalized;
}

function pasteEvent(bytes: Uint8Array, metadata?: PasteEvent["metadata"]): CanonicalPasteEvent {
  return {
    kind: "paste",
    payloadHex: bytesToHex(bytes),
    length: bytes.byteLength,
    ...(metadata?.mimeType === undefined ? {} : { mimeType: metadata.mimeType }),
    ...(metadata?.kind === undefined ? {} : { pasteKind: metadata.kind }),
  };
}

function mouseEvent(
  event: RawMouseEvent,
  source: CanonicalMouseEvent["source"],
  rawHex?: string,
  encoding?: CanonicalMouseEvent["encoding"],
): CanonicalMouseEvent {
  return {
    kind: "mouse",
    eventType: event.type,
    button: event.button,
    column0: event.x,
    row0: event.y,
    ctrl: event.modifiers.ctrl,
    alt: event.modifiers.alt,
    shift: event.modifiers.shift,
    source,
    ...(encoding === undefined ? {} : { encoding }),
    ...(rawHex === undefined ? {} : { rawHex }),
    ...(event.scroll === undefined ? {} : { scroll: event.scroll }),
  };
}

/** Normalize one public OpenTUI stdin-parser event into Xi's spike contract. */
export function normalizeStdinEvent(event: StdinEvent): CanonicalInputEvent {
  switch (event.type) {
    case "key":
      return keyEvent(event.key, event.raw);
    case "paste":
      return pasteEvent(event.bytes, event.metadata);
    case "mouse":
      return mouseEvent(event.event, "stdin-parser", bytesToHex(Buffer.from(event.raw, "utf8")), event.encoding);
    case "response":
      return {
        kind: "response",
        protocol: event.protocol,
        sequenceHex: bytesToHex(Buffer.from(event.sequence, "utf8")),
      };
    default:
      return assertNever(event);
  }
}

/** Normalize a renderer key event; subscribe to keypress and keyrelease once each. */
export function normalizeRendererKey(event: KeyEvent): CanonicalKeyEvent {
  return keyEvent(event, event.raw);
}

export function normalizeRendererPaste(event: PasteEvent): CanonicalPasteEvent {
  return pasteEvent(event.bytes, event.metadata);
}

/** Renderer focus events are already mapped from CSI I/O by OpenTUI. */
export function normalizeRendererFocus(kind: "focus" | "blur"): CanonicalFocusEvent {
  return { kind };
}

/** Renderer mouse events have already been hit-tested into a renderable. */
export function normalizeRendererMouse(event: MouseEvent): CanonicalMouseEvent {
  return mouseEvent(
    {
      type: event.type,
      button: event.button,
      x: event.x,
      y: event.y,
      modifiers: event.modifiers,
      ...(event.scroll === undefined ? {} : { scroll: event.scroll }),
    },
    "renderer",
  );
}

function assertNever(value: never): never {
  throw new Error(`unsupported OpenTUI stdin event: ${JSON.stringify(value)}`);
}
