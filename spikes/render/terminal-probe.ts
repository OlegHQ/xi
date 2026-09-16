import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createCliRenderer,
  resolveRenderLib,
  type CliRenderer,
} from "@opentui/core";
import { SyntheticViewportRenderable } from "./synthetic-viewport.js";

type Scenario = "visual" | "close" | "error";

const ARTIFACT_ROOT = resolve(process.cwd(), ".artifacts", "t002", "terminal");
const scenarioArgument = process.argv[2] ?? "visual";

if (scenarioArgument !== "visual" && scenarioArgument !== "close" && scenarioArgument !== "error") {
  throw new Error(`Unsupported terminal probe scenario: ${scenarioArgument}`);
}
const scenario: Scenario = scenarioArgument;

function makeRows(width: number, height: number): string[] {
  const rows = Array.from({ length: height }, (_, row) => {
    const label = `line-${String(row).padStart(4, "0")}`;
    return `${label}${"-".repeat(Math.max(width - label.length, 0))}`.slice(0, width);
  });
  if (rows.length > 0) {
    rows[0] = `Xi OpenTUI render spike  |  ${width}x${height}`;
  }
  if (rows.length > 1) {
    rows[1] = "Synthetic visible rows; no editable widget or document storage";
  }
  if (rows.length > 2) {
    rows[2] = "Unicode center: left -------- 😀 -------- right";
  }
  if (rows.length > 3) {
    rows[3] = "One-cell edits repaint one row; cursor moves repaint zero text cells";
  }
  if (rows.length > 4) {
    rows[4] = `${"x".repeat(Math.max(width - 1, 0))}😀`;
  }
  if (rows.length > 5) {
    rows[5] = "The row after the clipped wide glyph remains aligned";
  }
  return rows;
}

function writeJson(fileName: string, value: unknown): void {
  const path = resolve(ARTIFACT_ROOT, fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const lib = resolveRenderLib();
  const rawModeBefore = process.stdin.isRaw ?? false;
  let rawModeAtFirstFrame: boolean | undefined;
  let exitReason = "still-running";
  let renderError: string | undefined;
  let firstFrameSeen = false;
  let renderer: CliRenderer | undefined;
  let viewport: SyntheticViewportRenderable | undefined;

  renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    exitOnCtrlC: false,
    useMouse: false,
    backgroundColor: "#1e1e1e",
    targetFps: 30,
    onDestroy: () => {
      const rawModeAfterDestroy = process.stdin.isRaw ?? false;
      writeJson(`${scenario}-status.json`, {
        scenario,
        exitReason,
        renderError,
        firstFrameSeen,
        rendererDestroyed: renderer?.isDestroyed ?? false,
        viewportDestroyed: viewport?.isDestroyed ?? false,
        terminal: {
          isTTY: process.stdin.isTTY ?? false,
          rawModeBefore: rawModeBefore,
          rawModeAtFirstFrame,
          rawModeAfterDestroy,
          rawModeRestored: rawModeAfterDestroy === rawModeBefore,
        },
        nativeAllocationsAfterDestroy: lib.getAllocatorStats().activeAllocations,
      });
      setImmediate(() => process.exit(0));
    },
  });

  viewport = new SyntheticViewportRenderable(renderer.root.ctx, {
    rows: makeRows(renderer.width, renderer.height),
    fg: "#f8f8f2",
    bg: "#1e1e1e",
    cursor: {
      row: Math.min(6, Math.max(renderer.height - 1, 0)),
      col: Math.min(5, Math.max(renderer.width - 1, 0)),
      visible: true,
    },
  });
  renderer.root.add(viewport);

  renderer.on("frame", () => {
    if (firstFrameSeen) {
      return;
    }
    firstFrameSeen = true;
    rawModeAtFirstFrame = process.stdin.isRaw ?? false;
    writeJson(`${scenario}-ready.json`, {
      scenario,
      width: renderer?.width ?? 0,
      height: renderer?.height ?? 0,
      viewportWidth: viewport?.width ?? 0,
      viewportHeight: viewport?.height ?? 0,
      rawMode: rawModeAtFirstFrame,
    });
  });

  renderer.on("render:error", ({ error }) => {
    renderError = error.message;
    exitReason = "render-error";
    renderer?.destroy();
  });

  renderer.keyInput.on("keypress", (event) => {
    if (event.name === "q") {
      exitReason = "q";
      renderer?.destroy();
    } else if (event.name === "e") {
      viewport?.requestErrorOnNextRender("injected terminal render failure");
    }
  });

  renderer.start();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
