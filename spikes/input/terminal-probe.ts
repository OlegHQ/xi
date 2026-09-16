import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import {
  normalizeRendererFocus,
  normalizeRendererKey,
  normalizeRendererMouse,
  normalizeRendererPaste,
  type CanonicalInputEvent,
} from "./types.js";
import { Utf8TerminalInput } from "./utf8-boundary.js";

type ProbeMode = "legacy" | "legacy-guarded" | "kitty";

const modeArgument = process.argv[2];
if (modeArgument !== "legacy" && modeArgument !== "legacy-guarded" && modeArgument !== "kitty") {
  throw new Error(`Expected protocol mode legacy|legacy-guarded|kitty, got ${String(modeArgument)}`);
}
const mode: ProbeMode = modeArgument;
const protocolMode = mode === "kitty" ? "kitty" : "legacy";
const utf8GuardEnabled = mode === "legacy-guarded";
const artifactRoot = resolve(process.cwd(), ".artifacts/input/pty");
const statusPath = resolve(artifactRoot, `${mode}-status.json`);

const rawModeBefore = process.stdin.isRaw ?? false;
const eventCounts: Record<string, number> = {
  keypress: 0,
  keyrelease: 0,
  paste: 0,
  focus: 0,
  blur: 0,
  mouse: 0,
};
const events: CanonicalInputEvent[] = [];
let exitReason = "still-running";
let firstFrameSeen = false;
let rawModeAtFirstFrame: boolean | undefined;
let renderer: CliRenderer | undefined;
let target: BoxRenderable | undefined;
let inputAdapter: Utf8TerminalInput | undefined;

function record(kind: keyof typeof eventCounts, event: CanonicalInputEvent): void {
  eventCounts[kind] = (eventCounts[kind] ?? 0) + 1;
  events.push(event);
  process.stderr.write(`\r\nXI_EVENT ${JSON.stringify(event)}\r\n`);
  if (kind === "keypress" && event.kind === "key" && event.name === "q" && !event.ctrl && !event.meta) {
    exitReason = "q";
    renderer?.destroy();
  }
}

function writeStatus(): void {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify({
    mode,
    utf8GuardEnabled,
    exitReason,
    firstFrameSeen,
    rawMode: {
      before: rawModeBefore,
      atFirstFrame: rawModeAtFirstFrame,
      afterDestroy: process.stdin.isRaw ?? false,
      restored: (process.stdin.isRaw ?? false) === rawModeBefore,
    },
    rendererDestroyed: renderer?.isDestroyed ?? false,
    targetDestroyed: target?.isDestroyed ?? false,
    eventCounts,
    events,
  }, null, 2)}\n`, "utf8");
  setImmediate(() => process.exit(0));
}

async function main(): Promise<void> {
  mkdirSync(artifactRoot, { recursive: true });
  if (utf8GuardEnabled) inputAdapter = new Utf8TerminalInput(process.stdin);
  renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    exitOnCtrlC: false,
    useMouse: true,
    consoleMode: "disabled",
    ...(inputAdapter === undefined ? {} : { stdin: inputAdapter.asOpenTuiReadStream() }),
    useKittyKeyboard: protocolMode === "kitty"
      ? { disambiguate: true, alternateKeys: true, events: true }
      : { disambiguate: false, alternateKeys: false, events: false, allKeysAsEscapes: false, reportText: false },
    targetFps: 30,
    onDestroy: () => {
      inputAdapter?.dispose();
      writeStatus();
    },
  });

  if (protocolMode === "legacy") {
    // OpenTUI 0.5.11 treats null like its default Kitty config; use its public
    // method so the parser context and terminal mode both switch to legacy.
    renderer.disableKittyKeyboard();
  }

  target = new BoxRenderable(renderer.root.ctx, {
    width: "100%",
    height: "100%",
    backgroundColor: "#1e1e1e",
    shouldFill: true,
    onMouseDown: (event) => record("mouse", normalizeRendererMouse(event)),
  });
  renderer.root.add(target);

  renderer.keyInput.on("keypress", (event) => record("keypress", normalizeRendererKey(event)));
  renderer.keyInput.on("keyrelease", (event) => record("keyrelease", normalizeRendererKey(event)));
  renderer.keyInput.on("paste", (event) => record("paste", normalizeRendererPaste(event)));
  renderer.on("focus", () => record("focus", normalizeRendererFocus("focus")));
  renderer.on("blur", () => record("blur", normalizeRendererFocus("blur")));
  renderer.on("frame", () => {
    if (firstFrameSeen) return;
    firstFrameSeen = true;
    rawModeAtFirstFrame = process.stdin.isRaw ?? false;
    process.stderr.write(`\r\nXI_READY ${JSON.stringify({
      mode,
      width: renderer?.width ?? 0,
      height: renderer?.height ?? 0,
      rawMode: rawModeAtFirstFrame,
      kittyKeyboard: renderer?.useKittyKeyboard ?? false,
    })}\r\n`);
  });
  renderer.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
