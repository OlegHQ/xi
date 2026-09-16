import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import * as os from "node:os";
import { Writable } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import { resolveRenderLib, type NativeRenderStats } from "@opentui/core";
import { SyntheticViewportRenderable, type DirtySpan } from "./synthetic-viewport.js";

const ARTIFACT_ROOT = resolve(process.cwd(), ".artifacts", "t002");

interface BenchmarkCase {
  width: number;
  height: number;
  iterations: number;
}

interface BenchmarkSample {
  iteration: number;
  inputKey: "x" | "y";
  editToOutputMs: number;
  outputBytes: number;
  cellsUpdated: number;
  nativeRenderTime: number;
  nativeStdoutWriteTime: number;
}

interface ProbeEvidence {
  id: string;
  size: string;
  initial: {
    outputBytes: number;
    cellsUpdated: number;
    frameCount: number;
    nativeRenderTime: number;
    nativeStdoutWriteTime: number;
    /** Zero-based viewport coordinates in [x, y] order. */
    cursor: [number, number];
  };
  oneCellChange: {
    dirtySpans: DirtySpan[];
    paintedRows: number[];
    changedRows: number[];
    cellsUpdated: number;
    outputBytes: number;
    fullRepaint: boolean;
    contentRetained: boolean;
  };
  cursor: {
    /** Zero-based viewport coordinates in [x, y] order. */
    position: [number, number];
    /** One-based coordinates passed to RenderContext.setCursorPosition. */
    renderContextPosition: [number, number];
    cellsUpdated: number;
    paintedRows: number[];
    outputBytes: number;
  };
  unicode: {
    wideGlyphCenterRow: string;
    rightEdgeRow: string;
    rightEdgeBehavior: "clipped" | "replacement" | "visible";
    rightEdgeDisplayWidth: number;
    nextRowUnchanged: boolean;
  };
  resize: {
    toWidth: number;
    toHeight: number;
    rendererSize: [number, number];
    viewportSize: [number, number];
    frameSize: [number, number];
    fullPaintCellsUpdated: number;
  };
  benchmark: {
    iterations: number;
    inputEvents: number;
    p50EditToOutputMs: number;
    p95EditToOutputMs: number;
    p99EditToOutputMs: number;
    maxEditToOutputMs: number;
    totalOutputBytes: number;
    averageOutputBytes: number;
    totalCellsUpdated: number;
    averageCellsUpdated: number;
    processCpuUserMs: number;
    processCpuSystemMs: number;
    rssBeforeBytes: number;
    rssAfterBytes: number;
  };
  rawSamples: BenchmarkSample[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface PendingWrite {
  started: Deferred<void>;
  release: Deferred<void>;
}

function withDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

class CaptureOutput extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;
  #chunks: Buffer[] = [];
  #bytesWritten = 0;
  #nextBlockedWrite: PendingWrite | undefined;

  constructor(columns: number, rows: number, highWaterMark = 64 * 1024) {
    super({ highWaterMark });
    this.columns = columns;
    this.rows = rows;
  }

  getColorDepth(): number {
    return 24;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  outputSince(offset: number): Buffer {
    return Buffer.concat(this.#chunks).subarray(offset);
  }

  blockNextWrite(): PendingWrite {
    if (this.#nextBlockedWrite !== undefined) {
      throw new Error("An output write is already armed for backpressure");
    }
    const pending = { started: withDeferred<void>(), release: withDeferred<void>() };
    this.#nextBlockedWrite = pending;
    return pending;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
    this.#chunks.push(bytes);
    this.#bytesWritten += bytes.length;

    const pending = this.#nextBlockedWrite;
    if (pending === undefined) {
      callback();
      return;
    }
    this.#nextBlockedWrite = undefined;
    pending.started.resolve();
    void pending.release.promise.then(() => callback());
  }
}

function waitOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}

function requireCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] ?? 0;
}

function makeFixtureRows(width: number, height: number): string[] {
  return Array.from({ length: height }, (_, row) => {
    const tag = `line-${String(row).padStart(4, "0")}`;
    return `${tag}${"-".repeat(Math.max(width - tag.length, 0))}`.slice(0, width);
  });
}

function rowFromFrame(frame: string, row: number): string {
  return frame.split("\n")[row] ?? "";
}

function rowTextFromSpans(frame: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>, row: number): string {
  return frame.lines[row]?.spans.map((span) => span.text).join("") ?? "";
}

function rowDisplayWidth(frame: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>, row: number): number {
  return frame.lines[row]?.spans.reduce((total, span) => total + span.width, 0) ?? 0;
}

function summarizeNativeStats(stats: NativeRenderStats): {
  cellsUpdated: number;
  frameCount: number;
  nativeRenderTime: number;
  nativeStdoutWriteTime: number;
} {
  return {
    cellsUpdated: stats.cellsUpdated,
    frameCount: stats.nativeFrameCount,
    nativeRenderTime: stats.nativeRenderTime ?? 0,
    nativeStdoutWriteTime: stats.nativeStdoutWriteTime ?? 0,
  };
}

function writeArtifact(fileName: string, contents: string | Uint8Array): void {
  const artifactPath = join(ARTIFACT_ROOT, fileName);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, contents);
}

async function runLocaleProbeCase(item: BenchmarkCase): Promise<ProbeEvidence> {
  const output = new CaptureOutput(item.width, item.height);
  const setup = await createTestRenderer({
    width: item.width,
    height: item.height,
    stdout: output as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    gatherStats: true,
  });

  const fixtureRows = makeFixtureRows(item.width, item.height);
  const viewport = new SyntheticViewportRenderable(setup.renderer.root.ctx, {
    width: "100%",
    height: "100%",
    rows: fixtureRows,
    fg: "#f8f8f2",
    bg: "#1e1e1e",
    attributes: 0,
    cursor: { row: 2, col: 5, visible: true },
  });
  setup.renderer.root.add(viewport);

  const sampleRow = Math.min(item.height - 1, Math.floor(item.height * 0.3));
  const sampleCol = Math.min(item.width - 1, Math.floor(item.width * 0.8));
  setup.renderer.keyInput.on("keypress", (event) => {
    if (event.name === "x") {
      viewport.setCell(sampleRow, sampleCol, "A");
    } else if (event.name === "y") {
      viewport.setCell(sampleRow, sampleCol, "B");
    }
  });

  let oneCellChange: ProbeEvidence["oneCellChange"] | undefined;
  let cursorEvidence: ProbeEvidence["cursor"] | undefined;
  let unicodeEvidence: ProbeEvidence["unicode"] | undefined;
  let resizeEvidence: ProbeEvidence["resize"] | undefined;
  let benchmarkEvidence: ProbeEvidence["benchmark"] | undefined;
  let rawSamples: BenchmarkSample[] = [];
  let initialEvidence: ProbeEvidence["initial"] | undefined;
  let initialFrame = "";

  try {
    await setup.renderOnce();
    initialFrame = setup.captureCharFrame();
    const initialStats = summarizeNativeStats(setup.getNativeStats());
    const initialOutput = output.outputSince(0);
    const initialSpans = setup.captureSpans();
    initialEvidence = {
      outputBytes: initialOutput.length,
      ...initialStats,
      cursor: [initialSpans.cursor[0] - 1, initialSpans.cursor[1] - 1],
    };
    writeArtifact(`${item.width}x${item.height}/01-initial.ansi`, initialOutput);
    writeArtifact(`${item.width}x${item.height}/01-initial.txt`, initialFrame);

    const oneCellOffset = output.bytesWritten;
    viewport.setCell(2, 5, "@");
    const dirtySpans = viewport.peekDirtySpans();
    await setup.renderOnce();
    const oneCellOutput = output.outputSince(oneCellOffset);
    const oneCellStats = summarizeNativeStats(setup.getNativeStats());
    const oneCellFrame = setup.captureCharFrame();
    const originalLines = initialFrame.split("\n");
    const changedLines = oneCellFrame.split("\n");
    const changedRows = originalLines.flatMap((line, row) =>
      line === (changedLines[row] ?? "") ? [] : [row],
    );
    const paintedRows = [...viewport.lastPaintedRows];
    const contentRetained =
      rowFromFrame(oneCellFrame, 0) === rowFromFrame(initialFrame, 0) &&
      rowFromFrame(oneCellFrame, item.height - 1) === rowFromFrame(initialFrame, item.height - 1) &&
      rowFromFrame(oneCellFrame, 2).includes("@");
    const fullRepaint =
      oneCellStats.cellsUpdated >= item.width * item.height ||
      oneCellOutput.length >= initialOutput.length / 2 ||
      paintedRows.length >= item.height ||
      changedRows.length >= item.height;
    oneCellChange = {
      dirtySpans,
      paintedRows,
      changedRows,
      cellsUpdated: oneCellStats.cellsUpdated,
      outputBytes: oneCellOutput.length,
      fullRepaint,
      contentRetained,
    };
    writeArtifact(`${item.width}x${item.height}/02-one-cell.ansi`, oneCellOutput);
    writeArtifact(`${item.width}x${item.height}/02-one-cell.txt`, oneCellFrame);
    requireCondition(dirtySpans.length === 1 && dirtySpans[0]?.row === 2 && dirtySpans[0].startCol === 5 && dirtySpans[0].endCol === 6,
      `${item.width}x${item.height}: one-cell dirty span was not [row 2, col 5..6)`);
    requireCondition(paintedRows.length === 1 && paintedRows[0] === 2,
      `${item.width}x${item.height}: one-cell update repainted rows ${paintedRows.join(",")}`);
    requireCondition(oneCellStats.cellsUpdated === 1 && changedRows.length === 1 && changedRows[0] === 2,
      `${item.width}x${item.height}: native terminal output changed ${oneCellStats.cellsUpdated} cells across rows ${changedRows.join(",")}`);
    requireCondition(!fullRepaint && contentRetained && oneCellOutput.length < initialOutput.length / 2,
      `${item.width}x${item.height}: one-cell output repainted or cleared the visible document`);

    const cursorOffset = output.bytesWritten;
    viewport.setCursor(11, 17, true);
    await setup.renderOnce();
    const cursorFrame = setup.captureSpans();
    const cursorStats = summarizeNativeStats(setup.getNativeStats());
    const cursorOutput = output.outputSince(cursorOffset);
    cursorEvidence = {
      position: [cursorFrame.cursor[0] - 1, cursorFrame.cursor[1] - 1],
      renderContextPosition: cursorFrame.cursor,
      cellsUpdated: cursorStats.cellsUpdated,
      paintedRows: [...viewport.lastPaintedRows],
      outputBytes: cursorOutput.length,
    };
    writeArtifact(`${item.width}x${item.height}/03-cursor.ansi`, cursorOutput);
    requireCondition(cursorFrame.cursor[0] === 18 && cursorFrame.cursor[1] === 12,
      `${item.width}x${item.height}: one-based cursor projection did not move to [18,12]`);
    requireCondition(cursorStats.cellsUpdated === 0 && viewport.lastPaintedRows.length === 0,
      `${item.width}x${item.height}: cursor-only movement repainted text cells`);

    const centerText = `left-${"-".repeat(8)} 😀 terminal-width`;
    const centerOffset = output.bytesWritten;
    viewport.setRowText(0, centerText);
    await setup.renderOnce();
    const centerFrame = setup.captureSpans();
    const wideGlyphCenterRow = rowTextFromSpans(centerFrame, 0);
    writeArtifact(`${item.width}x${item.height}/04-wide-center.ansi`, output.outputSince(centerOffset));

    const edgeText = `${"x".repeat(item.width - 1)}😀`;
    const nextRowBeforeEdge = rowFromFrame(setup.captureCharFrame(), 1);
    const edgeOffset = output.bytesWritten;
    viewport.setRowText(0, edgeText);
    await setup.renderOnce();
    const edgeFrame = setup.captureSpans();
    const edgeOutputFrame = setup.captureCharFrame();
    const rightEdgeRow = rowTextFromSpans(edgeFrame, 0);
    const rightEdgeDisplayWidth = rowDisplayWidth(edgeFrame, 0);
    const rightEdgeBehavior = rightEdgeRow.includes("😀")
      ? "visible"
      : rightEdgeRow.includes("\ufffd")
        ? "replacement"
        : "clipped";
    const nextRowUnchanged = rowFromFrame(edgeOutputFrame, 1) === nextRowBeforeEdge;
    unicodeEvidence = {
      wideGlyphCenterRow,
      rightEdgeRow,
      rightEdgeBehavior,
      rightEdgeDisplayWidth,
      nextRowUnchanged,
    };
    writeArtifact(`${item.width}x${item.height}/04-wide-center.txt`, wideGlyphCenterRow);
    writeArtifact(`${item.width}x${item.height}/05-wide-right-edge.txt`, rightEdgeRow);
    writeArtifact(`${item.width}x${item.height}/05-wide-right-edge.ansi`, output.outputSince(edgeOffset));
    requireCondition(rightEdgeDisplayWidth === item.width,
      `${item.width}x${item.height}: wide glyph exceeded the ${item.width}-cell viewport edge`);
    requireCondition(nextRowUnchanged,
      `${item.width}x${item.height}: wide glyph at the right edge wrapped into the next row`);

    const samples: BenchmarkSample[] = [];
    const frameTimes: number[] = [];
    const processCpuBefore = process.cpuUsage();
    const rssBeforeBytes = process.memoryUsage().rss;

    for (let iteration = 0; iteration < item.iterations; iteration += 1) {
      const inputKey: "x" | "y" = iteration % 2 === 0 ? "x" : "y";
      const outputOffset = output.bytesWritten;
      const start = performance.now();
      setup.mockInput.pressKey(inputKey);
      await setup.renderOnce();
      const elapsed = performance.now() - start;
      const stats = summarizeNativeStats(setup.getNativeStats());
      const sample = {
        iteration,
        inputKey,
        editToOutputMs: elapsed,
        outputBytes: output.outputSince(outputOffset).length,
        cellsUpdated: stats.cellsUpdated,
        nativeRenderTime: stats.nativeRenderTime,
        nativeStdoutWriteTime: stats.nativeStdoutWriteTime,
      };
      samples.push(sample);
      frameTimes.push(elapsed);
      requireCondition(sample.cellsUpdated === 1,
        `${item.width}x${item.height}: benchmark sample ${iteration} updated ${sample.cellsUpdated} cells`);
    }

    const processCpu = process.cpuUsage(processCpuBefore);
    const rssAfterBytes = process.memoryUsage().rss;
    const totalOutputBytes = samples.reduce((total, sample) => total + sample.outputBytes, 0);
    const totalCellsUpdated = samples.reduce((total, sample) => total + sample.cellsUpdated, 0);
    rawSamples = samples;
    benchmarkEvidence = {
      iterations: samples.length,
      inputEvents: samples.length,
      p50EditToOutputMs: percentile(frameTimes, 0.5),
      p95EditToOutputMs: percentile(frameTimes, 0.95),
      p99EditToOutputMs: percentile(frameTimes, 0.99),
      maxEditToOutputMs: Math.max(...frameTimes, 0),
      totalOutputBytes,
      averageOutputBytes: totalOutputBytes / Math.max(samples.length, 1),
      totalCellsUpdated,
      averageCellsUpdated: totalCellsUpdated / Math.max(samples.length, 1),
      processCpuUserMs: processCpu.user / 1000,
      processCpuSystemMs: processCpu.system / 1000,
      rssBeforeBytes,
      rssAfterBytes,
    };
    writeArtifact(`${item.width}x${item.height}/06-benchmark-raw.json`, JSON.stringify(samples, null, 2));

    const resizeTargetWidth = item.width === 120 ? 120 : item.width + 20;
    const resizeTargetHeight = item.height === 40 ? 70 : item.height + 10;
    setup.resize(resizeTargetWidth, resizeTargetHeight);
    await setup.renderOnce();
    const resized = setup.captureSpans();
    const resizeOutputFrame = setup.captureCharFrame();
    resizeEvidence = {
      toWidth: resizeTargetWidth,
      toHeight: resizeTargetHeight,
      rendererSize: [setup.renderer.width, setup.renderer.height],
      viewportSize: [viewport.size.width, viewport.size.height],
      frameSize: [resized.cols, resized.rows],
      fullPaintCellsUpdated: setup.getNativeStats().cellsUpdated,
    };
    writeArtifact(`${resizeTargetWidth}x${resizeTargetHeight}/07-resized.txt`, resizeOutputFrame);
    requireCondition(
      setup.renderer.width === resizeTargetWidth &&
      setup.renderer.height === resizeTargetHeight &&
      viewport.width === resizeTargetWidth &&
      viewport.height === resizeTargetHeight &&
      resized.cols === resizeTargetWidth && resized.rows === resizeTargetHeight,
      `${item.width}x${item.height}: resized viewport did not cover the renderer geometry`,
    );
  } finally {
    setup.renderer.destroy();
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  requireCondition(initialEvidence !== undefined, "Initial render evidence was not produced");
  requireCondition(oneCellChange !== undefined, "One-cell evidence was not produced");
  requireCondition(cursorEvidence !== undefined, "Cursor evidence was not produced");
  requireCondition(unicodeEvidence !== undefined, "Unicode evidence was not produced");
  requireCondition(resizeEvidence !== undefined, "Resize evidence was not produced");
  requireCondition(benchmarkEvidence !== undefined, "Benchmark evidence was not produced");

  return {
    id: `t002-${item.width}x${item.height}`,
    size: `${item.width}x${item.height}`,
    initial: initialEvidence,
    oneCellChange,
    cursor: cursorEvidence,
    unicode: unicodeEvidence,
    resize: resizeEvidence,
    benchmark: benchmarkEvidence,
    rawSamples,
  };
}

async function runFailureCaseResizeWhileBackpressured(): Promise<{
  id: string;
  outputBlocked: boolean;
  outputStillBlockedAtResize: boolean;
  resizeOccurredBeforeDrain: boolean;
  renderLoopSettledWhileWriteBlocked: boolean;
  rendererSizeAtResize: [number, number];
  viewportSizeAfterDrain: [number, number];
  finalFrameSize: [number, number];
  finalRow: string;
  error?: string;
}> {
  const output = new CaptureOutput(80, 28, 1);
  const setup = await createTestRenderer({
    width: 80,
    height: 28,
    stdout: output as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    gatherStats: true,
  });
  const viewport = new SyntheticViewportRenderable(setup.renderer.root.ctx, {
    rows: makeFixtureRows(80, 28),
    fg: "#d7d7d7",
    bg: "#141414",
    cursor: { row: 2, col: 5, visible: true },
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();

  const pendingWrite = output.blockNextWrite();
  viewport.setCell(2, 5, "@");
  let renderSettled = false;
  let renderError: string | undefined;
  const inFlight = setup.renderOnce().then(
    () => { renderSettled = true; },
    (error: unknown) => {
      renderSettled = true;
      renderError = error instanceof Error ? error.message : String(error);
    },
  );

  const outputBlocked = await waitOrTimeout(pendingWrite.started.promise, 1000) && output.writableNeedDrain;
  let outputStillBlockedAtResize = false;
  let resizeOccurredBeforeDrain = false;
  let renderLoopSettledWhileWriteBlocked = false;
  let rendererSizeAtResize: [number, number] = [setup.renderer.width, setup.renderer.height];
  let viewportSizeAfterDrain: [number, number] = [viewport.width, viewport.height];
  let finalFrameSize: [number, number] = [0, 0];
  let finalRow = "";

  try {
    requireCondition(outputBlocked, "Renderer stdout did not enter Node Writable backpressure");
    setup.resize(100, 30);
    outputStillBlockedAtResize = output.writableNeedDrain;
    rendererSizeAtResize = [setup.renderer.width, setup.renderer.height];
    resizeOccurredBeforeDrain = rendererSizeAtResize[0] === 100 && rendererSizeAtResize[1] === 30;
    renderLoopSettledWhileWriteBlocked = renderSettled;
    requireCondition(outputStillBlockedAtResize && resizeOccurredBeforeDrain,
      "Resize did not take effect while output was still backpressured");
  } catch (error) {
    renderError = error instanceof Error ? error.message : String(error);
  } finally {
    pendingWrite.release.resolve();
    await inFlight;
  }

  if (renderError === undefined) {
    await setup.renderOnce();
    const finalFrame = setup.captureSpans();
    const charFrame = setup.captureCharFrame();
    viewportSizeAfterDrain = [viewport.width, viewport.height];
    finalFrameSize = [finalFrame.cols, finalFrame.rows];
    finalRow = rowFromFrame(charFrame, 2);
  }
  setup.renderer.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  requireCondition(renderError === undefined, `Backpressure resize probe failed: ${renderError ?? "unknown"}`);
  requireCondition(viewportSizeAfterDrain[0] === 100 && viewportSizeAfterDrain[1] === 30,
    "Viewport layout did not catch up after output drained");
  requireCondition(finalFrameSize[0] === 100 && finalFrameSize[1] === 30,
    "Final frame did not have the resized dimensions");
  requireCondition(finalRow.includes("@"), "Final resized frame lost the in-flight cell edit");

  return {
    id: "t002-failure-resize-backpressure-01",
    outputBlocked,
    outputStillBlockedAtResize,
    resizeOccurredBeforeDrain,
    renderLoopSettledWhileWriteBlocked,
    rendererSizeAtResize,
    viewportSizeAfterDrain,
    finalFrameSize,
    finalRow,
  };
}

async function runCloseAndErrorProbe(): Promise<{
  id: string;
  errorObserved: boolean;
  rendererDestroyed: boolean;
  viewportDestroyed: boolean;
  allocatorActiveBefore: number;
  allocatorActiveAfterDestroy: number;
  allocatorReturnedToBaseline: boolean;
  finalFrame: string;
}> {
  const lib = resolveRenderLib();
  const allocatorBefore = lib.getAllocatorStats();
  const setup = await createTestRenderer({ width: 60, height: 12, bufferedOutput: "memory", gatherStats: true });
  const viewport = new SyntheticViewportRenderable(setup.renderer.root.ctx, {
    rows: makeFixtureRows(60, 12),
    fg: "#d7d7d7",
    bg: "#141414",
    cursor: { row: 1, col: 4, visible: true },
  });
  setup.renderer.root.add(viewport);

  let errorObserved = false;
  setup.renderer.on("render:error", (event) => {
    errorObserved = event.error instanceof Error && event.error.message === "synthetic viewport render failure";
    return true;
  });
  await setup.renderOnce();
  viewport.requestErrorOnNextRender("synthetic viewport render failure");
  await setup.renderOnce();
  const finalFrame = setup.captureCharFrame();
  setup.renderer.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const allocatorAfter = lib.getAllocatorStats();
  const rendererDestroyed = setup.renderer.isDestroyed;
  const viewportDestroyed = viewport.isDestroyed;
  const allocatorReturnedToBaseline = allocatorAfter.activeAllocations === allocatorBefore.activeAllocations;
  requireCondition(errorObserved, "Injected render error did not reach the render:error event");
  requireCondition(rendererDestroyed && viewportDestroyed, "Renderer or viewport did not dispose");
  requireCondition(allocatorReturnedToBaseline,
    `Native active allocations changed from ${allocatorBefore.activeAllocations} to ${allocatorAfter.activeAllocations} after close/error`);

  return {
    id: "t002-close-error-01",
    errorObserved,
    rendererDestroyed,
    viewportDestroyed,
    allocatorActiveBefore: allocatorBefore.activeAllocations,
    allocatorActiveAfterDestroy: allocatorAfter.activeAllocations,
    allocatorReturnedToBaseline,
    finalFrame,
  };
}

async function main(): Promise<void> {
  const benchmarkCases: BenchmarkCase[] = [
    { width: 120, height: 40, iterations: 120 },
    { width: 240, height: 70, iterations: 120 },
  ];
  const probeSummaries: ProbeEvidence[] = [];
  for (const item of benchmarkCases) {
    const result = await runLocaleProbeCase(item);
    probeSummaries.push(result);
    writeArtifact(`${item.width}x${item.height}/summary.json`, JSON.stringify(result, null, 2));
  }

  const backpressureResult = await runFailureCaseResizeWhileBackpressured();
  writeArtifact("failure-resize-backpressure.json", JSON.stringify(backpressureResult, null, 2));
  writeArtifact("failure-resize-backpressure.txt", backpressureResult.finalRow);

  const closeErrorResult = await runCloseAndErrorProbe();
  writeArtifact("close-error.json", JSON.stringify(closeErrorResult, null, 2));
  writeArtifact("close-error.txt", closeErrorResult.finalFrame);

  const cpuModel = os.cpus()[0]?.model;
  const rawEvidence = {
    case: "T002",
    command: "bun run spikes:render",
    environment: {
      bun: process.versions.bun ?? "unknown",
      opentui: "0.5.11",
      platform: process.platform,
      arch: process.arch,
      os: os.type(),
      kernel: os.release(),
      cpu: cpuModel !== undefined && cpuModel.toLowerCase() !== "unknown"
        ? cpuModel
        : "not reported by Bun/host",
    },
    probeSummaries,
    backpressureResult,
    closeErrorResult,
    rawArtifactRoot: ARTIFACT_ROOT,
  };
  writeArtifact("raw-summary.json", JSON.stringify(rawEvidence, null, 2));

  const summary = [
    "# T002 OpenTUI render spike",
    "",
    `Environment: Bun ${rawEvidence.environment.bun}, OpenTUI ${rawEvidence.environment.opentui}, ${rawEvidence.environment.os} ${rawEvidence.environment.kernel} (${rawEvidence.environment.platform}/${rawEvidence.environment.arch}); CPU model ${rawEvidence.environment.cpu}`,
    "",
    "## One-cell updates",
    ...probeSummaries.map((probe) =>
      `- ${probe.size}: ${probe.oneCellChange.cellsUpdated} native cell, ${probe.oneCellChange.outputBytes} output bytes, dirty=${JSON.stringify(probe.oneCellChange.dirtySpans)}, paintedRows=${JSON.stringify(probe.oneCellChange.paintedRows)}, fullRepaint=${probe.oneCellChange.fullRepaint}`),
    "",
    "## Cursor and Unicode",
    ...probeSummaries.map((probe) =>
      `- ${probe.size}: cursor logical [x,y]=${JSON.stringify(probe.cursor.position)} (RenderContext 1-based=${JSON.stringify(probe.cursor.renderContextPosition)}), ${probe.cursor.cellsUpdated} changed cells; right-edge wide glyph=${probe.unicode.rightEdgeBehavior}, terminal width=${probe.unicode.rightEdgeDisplayWidth}, next row unchanged=${probe.unicode.nextRowUnchanged}`),
    "",
    "## Input-to-output timing",
    ...probeSummaries.map((probe) =>
      `- ${probe.size}: ${probe.benchmark.inputEvents} OpenTUI key events, p50=${probe.benchmark.p50EditToOutputMs.toFixed(4)} ms, p95=${probe.benchmark.p95EditToOutputMs.toFixed(4)} ms, p99=${probe.benchmark.p99EditToOutputMs.toFixed(4)} ms, max=${probe.benchmark.maxEditToOutputMs.toFixed(4)} ms, average=${probe.benchmark.averageOutputBytes.toFixed(1)} output bytes/frame`),
    "",
    "## Resize under output backpressure",
    `- Fixture ${backpressureResult.id}: blocked=${backpressureResult.outputBlocked}, still blocked at resize=${backpressureResult.outputStillBlockedAtResize}, resized before drain=${backpressureResult.resizeOccurredBeforeDrain}, render call settled before drain=${backpressureResult.renderLoopSettledWhileWriteBlocked}, final frame=${backpressureResult.finalFrameSize.join("x")}`,
    "",
    "## Disposal after render error",
    `- Fixture ${closeErrorResult.id}: error observed=${closeErrorResult.errorObserved}, renderer destroyed=${closeErrorResult.rendererDestroyed}, viewport destroyed=${closeErrorResult.viewportDestroyed}, native allocations returned to baseline=${closeErrorResult.allocatorReturnedToBaseline}`,
    "",
    `Raw frames and per-iteration samples: ${ARTIFACT_ROOT}`,
  ];
  writeArtifact("summary.md", summary.join("\n"));
  process.stdout.write(`${summary.join("\n")}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
