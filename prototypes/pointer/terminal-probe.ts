import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import {
  normalizeRendererKey,
  normalizeRendererMouse,
  normalizeRendererPaste,
  type CanonicalInputEvent,
} from "../../spikes/input/types.js";
import { RendererPointerAdapter } from "./renderer-pointer-adapter.js";

type ProbeMode = "enabled" | "disabled" | "all-motion" | "failure" | "signal" | "job-control";

const modeArgument = process.argv[2];
if (modeArgument !== "enabled" && modeArgument !== "disabled" && modeArgument !== "all-motion" && modeArgument !== "failure" && modeArgument !== "signal" && modeArgument !== "job-control") {
  throw new Error(`Expected mode enabled|disabled|all-motion|failure|signal|job-control, got ${String(modeArgument)}`);
}
const mode: ProbeMode = modeArgument;
const useMouse = mode !== "disabled";
const artifactRoot = resolve(process.cwd(), ".artifacts/input/T084");
const statusPath = resolve(artifactRoot, `${mode}.status.json`);
const rawModeBefore = process.stdin.isRaw ?? false;
const events: CanonicalInputEvent[] = [];
const rawMouseCallbacks: Array<{ type: string; x: number; y: number; isDragging?: boolean }> = [];
const readChunks: string[] = [];
const lifecycle: Array<Record<string, unknown>> = [];
const handlerFailures: string[] = [];
let exitReason = "still-running";
let firstFrameSeen = false;
let rawModeAtFirstFrame: boolean | undefined;
let renderer: CliRenderer | undefined;
let target: BoxRenderable | undefined;
let pointerAdapter: RendererPointerAdapter | undefined;
let jobControlSuspended = false;

function suspendForJobControl(): void {
  if (!renderer || renderer.isDestroyed || jobControlSuspended) return;
  jobControlSuspended = true;
  lifecycle.push({ phase: "SIGTSTP-before-suspend", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
  marker("PHASE", lifecycle.at(-1));
  renderer.suspend();
  lifecycle.push({ phase: "suspended", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
  marker("PHASE", lifecycle.at(-1));
  process.off("SIGTSTP", suspendForJobControl);
  // Node may ignore a self-delivered SIGTSTP while its signal watcher is
  // being removed. Stop only after terminal cleanup; SIGCONT resumes us.
  process.kill(process.pid, "SIGSTOP");
}

function resumeFromJobControl(): void {
  if (!renderer || renderer.isDestroyed || !jobControlSuspended) return;
  jobControlSuspended = false;
  process.on("SIGTSTP", suspendForJobControl);
  renderer.resume();
  lifecycle.push({ phase: "resumed", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
  marker("PHASE", lifecycle.at(-1));
}

function marker(name: string, value: unknown): void {
  process.stderr.write(`\r\nXI_${name} ${JSON.stringify(value)}\r\n`);
}

function recordEvent(event: CanonicalInputEvent): void {
  events.push(event);
  marker("EVENT", event);
}

// Test-only observation of OS stream chunk boundaries. It does not inspect or
// decode bytes; StdinParser remains the only mouse/keyboard decoder.
function observeChunk(chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const hex = bytes.toString("hex");
  readChunks.push(hex);
  marker("CHUNK", { index: readChunks.length - 1, hex });
}

function writeStatus(): void {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify({
    mode,
    useMouse,
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
    eventCount: events.length,
    events,
    rawMouseCallbacks,
    readChunks,
    lifecycle,
    handlerFailures,
  }, null, 2)}\n`, "utf8");
  process.stdin.off("data", observeChunk);
  process.off("SIGTSTP", suspendForJobControl);
  process.off("SIGCONT", resumeFromJobControl);
  setImmediate(() => process.exit(0));
}

process.stdin.on("data", observeChunk);
process.on("SIGTERM", () => {
  exitReason = "signal:SIGTERM";
});

async function main(): Promise<void> {
  mkdirSync(artifactRoot, { recursive: true });
  renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    exitOnCtrlC: false,
    useMouse,
    enableMouseMovement: mode === "all-motion",
    consoleMode: "disabled",
    targetFps: 30,
    onDestroy: writeStatus,
  });

  pointerAdapter = new RendererPointerAdapter(recordEvent);

  target = new BoxRenderable(renderer.root.ctx, {
    width: "100%",
    height: "100%",
    backgroundColor: "#1e1e1e",
    shouldFill: true,
    onMouse: (event) => {
      const normalized = normalizeRendererMouse(event);
      rawMouseCallbacks.push({
        type: event.type,
        x: event.x,
        y: event.y,
        ...(event.isDragging === undefined ? {} : { isDragging: event.isDragging }),
      });
      marker("RENDERER_MOUSE", rawMouseCallbacks.at(-1));
      if (mode === "failure" && normalized.column0 === 10 && normalized.eventType === "down") {
        throw new Error("T084 injected pointer handler failure");
      }
      pointerAdapter?.handle(event);
    },
  });
  renderer.root.add(target);

  renderer.on("handler:error", (payload) => {
    const error = payload as { error?: unknown; event?: { type?: string; x?: number; y?: number } };
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    handlerFailures.push(message);
    marker("HANDLER_ERROR", {
      message,
      type: error.event?.type,
      x: error.event?.x,
      y: error.event?.y,
    });
  });

  if (mode === "job-control") {
    process.on("SIGTSTP", suspendForJobControl);
    process.on("SIGCONT", resumeFromJobControl);
  }

  renderer.keyInput.on("keypress", (event) => {
    const normalized = normalizeRendererKey(event);
    recordEvent(normalized);
    if (normalized.name === "s" && renderer) {
      lifecycle.push({ phase: "before-suspend", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
      marker("PHASE", lifecycle.at(-1));
      renderer.suspend();
      lifecycle.push({ phase: "suspended", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
      marker("PHASE", lifecycle.at(-1));
      setTimeout(() => {
        if (!renderer || renderer.isDestroyed) return;
        renderer.resume();
        lifecycle.push({ phase: "resumed", rawMode: process.stdin.isRaw ?? false, useMouse: renderer.useMouse });
        marker("PHASE", lifecycle.at(-1));
      }, 100);
    }
    if (normalized.name === "q" && !normalized.ctrl && !normalized.meta) {
      exitReason = "q";
      renderer?.destroy();
    }
  });
  renderer.keyInput.on("paste", (event) => recordEvent(normalizeRendererPaste(event)));
  renderer.on("frame", () => {
    if (firstFrameSeen) return;
    firstFrameSeen = true;
    rawModeAtFirstFrame = process.stdin.isRaw ?? false;
    marker("READY", {
      mode,
      width: renderer?.width ?? 0,
      height: renderer?.height ?? 0,
      rawMode: rawModeAtFirstFrame,
      useMouse: renderer?.useMouse ?? false,
    });
  });
  renderer.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
