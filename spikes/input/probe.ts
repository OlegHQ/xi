import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { StdinParser, type StdinEvent } from "@opentui/core";
import { ManualClock } from "@opentui/core/testing";
import { runOracleFixture, verifyOracleBundle } from "../../tests/oracle/oracle-runner.js";
import type { OracleFixture } from "../../tests/oracle/types.js";
import { normalizeStdinEvent, type CanonicalInputEvent } from "./types.js";
import { Utf8ChunkAccumulator } from "./utf8-boundary.js";

type Protocol = "legacy" | "kitty";
type Action =
  | { readonly op: "push"; readonly hex: string; readonly assertEventCount?: number }
  | { readonly op: "advance"; readonly milliseconds: number; readonly flush?: boolean; readonly assertEventCount?: number };

interface ParserCase {
  readonly id: string;
  readonly title: string;
  readonly protocol: Protocol;
  readonly actions: readonly Action[];
  readonly expected: readonly unknown[];
}

interface OracleCase {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly cursor: { readonly line: number; readonly byteColumn0: number };
  readonly keys: string;
  readonly expected: Readonly<Record<string, unknown>>;
}

interface Utf8GuardCase {
  readonly id: string;
  readonly title: string;
  readonly chunksHex: readonly string[];
  readonly expectedOutputsHex: readonly string[];
  readonly expectedFinishHex: string;
}

interface FixtureDocument {
  readonly schemaVersion: number;
  readonly openTuiVersion: string;
  readonly legacyEscapeTimeoutMs: number;
  readonly cases: readonly ParserCase[];
  readonly utf8GuardCases: readonly Utf8GuardCase[];
  readonly oracleCases: readonly OracleCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected string`);
  return value;
}

function expectInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") throw new Error(`${label}: expected safe integer`);
  return value;
}

function parseAction(value: unknown, label: string): Action {
  const action = expectRecord(value, label);
  if (action.op === "push") {
    const hex = expectString(action.hex, `${label}.hex`);
    hexToBytes(hex, `${label}.hex`);
    const assertEventCount = action.assertEventCount === undefined
      ? undefined
      : expectInteger(action.assertEventCount, `${label}.assertEventCount`);
    return {
      op: "push",
      hex,
      ...(assertEventCount === undefined ? {} : { assertEventCount }),
    };
  }
  if (action.op === "advance") {
    const milliseconds = expectInteger(action.milliseconds, `${label}.milliseconds`);
    if (milliseconds < 0) throw new Error(`${label}.milliseconds: must be non-negative`);
    const assertEventCount = action.assertEventCount === undefined
      ? undefined
      : expectInteger(action.assertEventCount, `${label}.assertEventCount`);
    if (action.flush !== undefined && typeof action.flush !== "boolean") {
      throw new Error(`${label}.flush: expected boolean`);
    }
    return {
      op: "advance",
      milliseconds,
      ...(action.flush === undefined ? {} : { flush: action.flush }),
      ...(assertEventCount === undefined ? {} : { assertEventCount }),
    };
  }
  throw new Error(`${label}.op: unsupported operation`);
}

function parseFixtureDocument(value: unknown): FixtureDocument {
  const document = expectRecord(value, "fixture");
  if (document.schemaVersion !== 1) throw new Error("fixture.schemaVersion: unsupported version");
  if (!Array.isArray(document.cases) || !Array.isArray(document.utf8GuardCases) || !Array.isArray(document.oracleCases)) {
    throw new Error("fixture: cases, utf8GuardCases and oracleCases must be arrays");
  }

  const cases: ParserCase[] = document.cases.map((rawCase, index) => {
    const label = `fixture.cases[${index}]`;
    const item = expectRecord(rawCase, label);
    if (item.protocol !== "legacy" && item.protocol !== "kitty") {
      throw new Error(`${label}.protocol: expected legacy or kitty`);
    }
    if (!Array.isArray(item.actions) || !Array.isArray(item.expected)) {
      throw new Error(`${label}: actions and expected must be arrays`);
    }
    return {
      id: expectString(item.id, `${label}.id`),
      title: expectString(item.title, `${label}.title`),
      protocol: item.protocol,
      actions: item.actions.map((action, actionIndex) => parseAction(action, `${label}.actions[${actionIndex}]`)),
      expected: item.expected,
    };
  });

  const oracleCases: OracleCase[] = document.oracleCases.map((rawCase, index) => {
    const label = `fixture.oracleCases[${index}]`;
    const item = expectRecord(rawCase, label);
    if (!Array.isArray(item.lines) || item.lines.some((line) => typeof line !== "string")) {
      throw new Error(`${label}.lines: expected strings`);
    }
    const cursor = expectRecord(item.cursor, `${label}.cursor`);
    return {
      id: expectString(item.id, `${label}.id`),
      title: expectString(item.title, `${label}.title`),
      lines: item.lines as string[],
      cursor: {
        line: expectInteger(cursor.line, `${label}.cursor.line`),
        byteColumn0: expectInteger(cursor.byteColumn0, `${label}.cursor.byteColumn0`),
      },
      keys: expectString(item.keys, `${label}.keys`),
      expected: expectRecord(item.expected, `${label}.expected`),
    };
  });

  const utf8GuardCases: Utf8GuardCase[] = document.utf8GuardCases.map((rawCase, index) => {
    const label = `fixture.utf8GuardCases[${index}]`;
    const item = expectRecord(rawCase, label);
    if (!Array.isArray(item.chunksHex) || !Array.isArray(item.expectedOutputsHex)) {
      throw new Error(`${label}: chunksHex and expectedOutputsHex must be arrays`);
    }
    if (item.chunksHex.length !== item.expectedOutputsHex.length) {
      throw new Error(`${label}: each input chunk needs one output trace`);
    }
    const chunksHex = item.chunksHex.map((hex, chunkIndex) => {
      const checked = expectString(hex, `${label}.chunksHex[${chunkIndex}]`);
      hexToBytes(checked, `${label}.chunksHex[${chunkIndex}]`);
      return checked;
    });
    const expectedOutputsHex = item.expectedOutputsHex.map((hex, outputIndex) => {
      const checked = expectString(hex, `${label}.expectedOutputsHex[${outputIndex}]`);
      hexToBytes(checked, `${label}.expectedOutputsHex[${outputIndex}]`);
      return checked;
    });
    const expectedFinishHex = expectString(item.expectedFinishHex, `${label}.expectedFinishHex`);
    hexToBytes(expectedFinishHex, `${label}.expectedFinishHex`);
    return {
      id: expectString(item.id, `${label}.id`),
      title: expectString(item.title, `${label}.title`),
      chunksHex,
      expectedOutputsHex,
      expectedFinishHex,
    };
  });

  return {
    schemaVersion: 1,
    openTuiVersion: expectString(document.openTuiVersion, "fixture.openTuiVersion"),
    legacyEscapeTimeoutMs: expectInteger(document.legacyEscapeTimeoutMs, "fixture.legacyEscapeTimeoutMs"),
    cases,
    utf8GuardCases,
    oracleCases,
  };
}

function hexToBytes(hex: string, label: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`${label}: expected an even-length hexadecimal byte string`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function assertSubset(expected: unknown, actual: unknown, path: string): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    assert.equal(actual.length, expected.length, `${path}: event/item count differs`);
    for (let index = 0; index < expected.length; index += 1) {
      assertSubset(expected[index], actual[index], `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(expected)) {
    assert.ok(isRecord(actual), `${path}: expected object`);
    for (const [key, expectedValue] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `${path}.${key}: missing from actual result`);
      assertSubset(expectedValue, actual[key], `${path}.${key}`);
    }
    return;
  }
  assert.deepStrictEqual(actual, expected, `${path}: value differs`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  return expectRecord(value, label);
}

function canonicalize(event: StdinEvent): CanonicalInputEvent {
  return normalizeStdinEvent(event);
}

async function readOpenTuiVersion(): Promise<string> {
  const packageValue: unknown = JSON.parse(await readFile("node_modules/@opentui/core/package.json", "utf8"));
  return expectString(asRecord(packageValue, "OpenTUI package").version, "OpenTUI package.version");
}

async function runParserCase(testCase: ParserCase, timeoutMs: number): Promise<{
  readonly id: string;
  readonly title: string;
  readonly events: readonly { readonly atManualMs: number; readonly event: CanonicalInputEvent }[];
  readonly oneToOneDelivery: boolean;
}> {
  const clock = new ManualClock();
  const kittyEnabled = testCase.protocol === "kitty";
  const parser = new StdinParser({
    timeoutMs,
    armTimeouts: false,
    useKittyKeyboard: kittyEnabled,
    protocolContext: { kittyKeyboardEnabled: kittyEnabled },
    clock,
  });
  const rawEvents: StdinEvent[] = [];
  const events: { atManualMs: number; event: CanonicalInputEvent }[] = [];
  try {
    const drain = (): void => {
      parser.drain((event) => {
        rawEvents.push(event);
        events.push({ atManualMs: clock.now(), event: canonicalize(event) });
      });
      assert.equal(events.length, rawEvents.length, `${testCase.id}: normalized event delivered more/less than once`);
    };

    for (const [index, action] of testCase.actions.entries()) {
      if (action.op === "push") {
        parser.push(hexToBytes(action.hex, `${testCase.id}.actions[${index}].hex`));
      } else {
        clock.advance(action.milliseconds);
        if (action.flush === true) parser.flushTimeout(clock.now());
      }
      drain();
      if (action.assertEventCount !== undefined) {
        assert.equal(events.length, action.assertEventCount, `${testCase.id}: event count after action ${index}`);
      }
    }
    assertSubset(testCase.expected, events.map((entry) => entry.event), `${testCase.id}.expected`);
    return {
      id: testCase.id,
      title: testCase.title,
      events,
      oneToOneDelivery: events.length === rawEvents.length,
    };
  } finally {
    parser.destroy();
  }
}

async function runOracleCase(testCase: OracleCase, binaryPath: string): Promise<Record<string, unknown>> {
  const fixture: OracleFixture = {
    id: testCase.id,
    title: testCase.title,
    purpose: "Compare control-C behavior in insert mode against the pinned Neovim development oracle.",
    modes: ["normal", "insert"],
    lines: testCase.lines,
    cursor: testCase.cursor,
    steps: [{ label: "after requested Ctrl-C sequence", keys: testCase.keys }],
  };
  const result = await runOracleFixture(fixture, binaryPath);
  const snapshot = result.snapshots[0];
  assert.ok(snapshot, `${testCase.id}: oracle returned no snapshot`);
  const actual = {
    lines: snapshot.lines,
    cursor: { line: snapshot.cursor.line, byteColumn: snapshot.cursor.byteColumn },
    mode: snapshot.mode,
    blocking: snapshot.blocking,
    error: snapshot.error,
    modified: snapshot.buffer.modified,
  };
  assertSubset(testCase.expected, actual, `${testCase.id}.expected`);
  return { id: testCase.id, actual };
}

function runUtf8GuardCase(testCase: Utf8GuardCase): Record<string, unknown> {
  const guard = new Utf8ChunkAccumulator();
  const outputsHex: string[] = [];
  for (const chunkHex of testCase.chunksHex) {
    outputsHex.push(toHex(guard.push(hexToBytes(chunkHex, `${testCase.id}.chunk`))));
  }
  const finishHex = toHex(guard.finish());
  assert.deepStrictEqual(outputsHex, testCase.expectedOutputsHex, `${testCase.id}: per-chunk output`);
  assert.equal(finishHex, testCase.expectedFinishHex, `${testCase.id}: final output`);
  return { id: testCase.id, outputsHex, finishHex };
}

async function main(): Promise<void> {
  const fixturePath = resolve(process.cwd(), "tests/fixtures/input/T006-protocol-cases.json");
  const fixture = parseFixtureDocument(JSON.parse(await readFile(fixturePath, "utf8")) as unknown);
  const installedOpenTuiVersion = await readOpenTuiVersion();
  assert.equal(installedOpenTuiVersion, fixture.openTuiVersion, "pinned OpenTUI fixture version mismatch");

  const parserCases = [];
  for (const testCase of fixture.cases) {
    parserCases.push(await runParserCase(testCase, fixture.legacyEscapeTimeoutMs));
  }
  const utf8GuardCases = fixture.utf8GuardCases.map(runUtf8GuardCase);

  const oracleBundle = await verifyOracleBundle();
  const oracleCases = [];
  for (const testCase of fixture.oracleCases) {
    oracleCases.push(await runOracleCase(testCase, oracleBundle.binaryPath));
  }

  const result = {
    schemaVersion: 1,
    ticket: "T006",
    runtime: {
      bun: process.versions.bun,
      opentui: installedOpenTuiVersion,
      platform: process.platform,
      architecture: process.arch,
    },
    parser: {
      timeoutMs: fixture.legacyEscapeTimeoutMs,
      caseCount: parserCases.length,
      oneToOneDelivery: parserCases.every((testCase) => testCase.oneToOneDelivery),
      cases: parserCases,
    },
    utf8BoundaryGuard: {
      caseCount: utf8GuardCases.length,
      cases: utf8GuardCases,
    },
    oracle: {
      version: oracleBundle.manifest.oracle.version,
      binarySha256: oracleBundle.manifest.oracle.binarySha256,
      runtimeDocsSha256: oracleBundle.manifest.oracle.runtimeDocs.sha256,
      cases: oracleCases,
    },
  };
  const outputPath = resolve(process.cwd(), ".artifacts/input/T006-parser-results.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, parserCases: parserCases.length, oracleCases: oracleCases.length }, null, 2));
}

await main();
