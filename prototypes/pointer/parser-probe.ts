import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MouseParser, StdinParser, type StdinEvent } from "@opentui/core";
import { normalizeStdinEvent, type CanonicalInputEvent } from "../../spikes/input/types.js";

const outputPath = resolve(process.cwd(), ".artifacts/input/T084/parser-results.json");
const outputDirectory = resolve(process.cwd(), ".artifacts/input/T084");
const packet = (code: number, column1: number, row1: number, release = false): Buffer =>
  Buffer.from(`\x1b[<${code};${column1};${row1}${release ? "m" : "M"}`, "ascii");

function feed(chunks: readonly Uint8Array[]): { events: CanonicalInputEvent[]; parser: StdinParser } {
  const parser = new StdinParser({ armTimeouts: false, useKittyKeyboard: false });
  for (const chunk of chunks) parser.push(chunk);
  const events: CanonicalInputEvent[] = [];
  parser.drain((event: StdinEvent) => events.push(normalizeStdinEvent(event)));
  return { events, parser };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mouseEvents(events: readonly CanonicalInputEvent[]): CanonicalInputEvent[] {
  return events.filter((event) => event.kind === "mouse");
}

const results: Array<Record<string, unknown>> = [];

const pointerSequence = feed([
  packet(0, 257, 3),
  packet(32, 259, 4),
  packet(0, 260, 4, true),
  packet(64, 299, 10),
  packet(65, 300, 10),
]);
assert(pointerSequence.events.length === 5, `expected one public parser event for each of five reports, got ${pointerSequence.events.length}`);
assert(pointerSequence.events.every((event) => event.kind === "mouse"), "a pointer packet became a key/paste event");
const [largeDown, drag, release, wheelUp, wheelDown] = pointerSequence.events;
assert(largeDown?.kind === "mouse" && largeDown.column0 === 256 && largeDown.row0 === 2, "large SGR coordinates did not remain zero-based cells");
assert(drag?.kind === "mouse" && drag.eventType === "drag" && drag.column0 === 258, "SGR pressed motion did not become drag");
assert(release?.kind === "mouse" && release.eventType === "up" && release.column0 === 259, "SGR release event was lost");
assert(wheelUp?.kind === "mouse" && wheelUp.scroll?.direction === "up", "SGR wheel-up did not preserve direction");
assert(wheelDown?.kind === "mouse" && wheelDown.scroll?.direction === "down", "SGR wheel-down did not preserve direction");
results.push({ fixture: "MP01-SGR-LARGE-01 / DRAG-01 / RELEASE-01 / WHEEL-01", outcome: "pass", events: pointerSequence.events });
pointerSequence.parser.destroy();

const modifierPackets = [4, 8, 16].map((code) => packet(code, 270, 12));
const modifiers = feed(modifierPackets);
assert(modifiers.events.length === 3 && modifiers.events.every((event) => event.kind === "mouse"), "modifier reports did not each decode once");
const modifierState = modifiers.events.map((event) => event.kind === "mouse" ? event : null);
assert(modifierState[0]?.shift === true && modifierState[1]?.alt === true && modifierState[2]?.ctrl === true, "SGR modifier bits were changed");
results.push({ fixture: "MP01-SGR-MODIFIERS-01", outcome: "pass", events: modifiers.events });
modifiers.parser.destroy();

const splitOffsets = [1, 2, 3, 4, 6, 8, 10];
const splitResults: Array<Record<string, unknown>> = [];
for (const [index, splitAt] of splitOffsets.entries()) {
  const bytes = packet(2, 150 + index, 20 + index);
  const split = feed([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]);
  const parsed = mouseEvents(split.events);
  assert(parsed.length === 1 && split.events.length === 1, `split ${splitAt} delivered ${split.events.length} events instead of one`);
  splitResults.push({ splitAtByte: splitAt, packetHex: bytes.toString("hex"), events: split.events });
  split.parser.destroy();
}
results.push({ fixture: "MP01-SGR-SPLIT-01", outcome: "pass", cases: splitResults });

const x10Bytes = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xff, 0xff]);
const x10 = feed([x10Bytes]);
assert(x10.events.length === 1 && x10.events[0]?.kind === "mouse", "X10 max-coordinate report was not decoded once");
assert(x10.events[0]?.kind === "mouse" && x10.events[0].column0 === 222 && x10.events[0].row0 === 222, "X10 coordinate ceiling changed");
results.push({ fixture: "MP01-X10-LIMIT-01", outcome: "pass-limited", inputHex: x10Bytes.toString("hex"), events: x10.events, limit: "zero-based x/y max 222" });
const x10Normalized = x10.events[0];
assert(x10Normalized?.kind === "mouse", "X10 report did not normalize to mouse");
assert(x10Normalized.rawHex !== x10Bytes.toString("hex"), "legacy raw-byte normalization defect no longer reproduces");
results.push({
  fixture: "MP01-X10-RAW-HEX-01",
  outcome: "defect-reproduced",
  inputWireHex: x10Bytes.toString("hex"),
  canonicalRawHex: x10Normalized.rawHex,
  defect: "StdinEvent.raw contains Latin-1 byte values, but T006 normalizeStdinEvent re-encodes it as UTF-8.",
  owner: "T035 canonical input adapter",
});
x10.parser.destroy();

const x10MotionBytes = Buffer.from([0x1b, 0x5b, 0x4d, 0x40, 0x22, 0x23]);
const x10Motion = feed([x10Bytes.subarray(0, 3), x10Bytes.subarray(3), x10MotionBytes]);
const x10Mouse = mouseEvents(x10Motion.events);
assert(x10Mouse.length === 2 && x10Mouse[1]?.kind === "mouse" && x10Mouse[1].eventType === "move", "X10 motion classification changed");
results.push({ fixture: "MP01-X10-MOTION-01", outcome: "pass-limited", inputHex: x10MotionBytes.toString("hex"), events: x10Motion.events, limit: "motion is move; no pressed-button drag tracking" });
x10Motion.parser.destroy();

const mouseParser = new MouseParser();
const hugeCoordinatePacket = Buffer.from("\x1b[<0;999999999999999999999999999999999999;1M", "ascii");
const hugeMouseEvent = mouseParser.parseMouseEvent(hugeCoordinatePacket);
assert(hugeMouseEvent !== null && Number.isFinite(hugeMouseEvent.x), "oversized SGR coordinate no longer reproduces as a finite value");
results.push({
  fixture: "MP02-COORDINATE-OVERFLOW-01",
  outcome: "defect-reproduced",
  inputHex: hugeCoordinatePacket.toString("hex"),
  event: hugeMouseEvent,
  requiredBoundary: "T085 must reject/clamp against a versioned frame before hit testing",
});

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ package: "@opentui/core@0.5.11", fixtureResults: results }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, fixtureCount: results.length, results }, null, 2));
