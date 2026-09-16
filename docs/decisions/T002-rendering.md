# T002: OpenTUI visible-row rendering prototype

## Decision

Prototype the editor viewport as a custom, disposable OpenTUI `Renderable`. Keep its synthetic visible rows in the fixture, with no editable widget or second document store. Treat viewport row/column positions as zero-based; convert a visible cursor to the one-based terminal coordinates required by `RenderContext.setCursorPosition` at the rendering boundary. Keep OpenTUI's retained buffer enabled so its native diff can emit only changed terminal cells.

This follows the ownership boundary in [the architecture specification](../plan/01-architecture.md): the document remains the sole mutable text owner, while the UI adapter renders visible state and positions the cursor. Vim, services, and document editing are outside this spike.

## Evidence and consequences

With OpenTUI 0.5.11's public `Renderable`, `RenderContext`, and test-renderer APIs, the probe produced real xterm frames at 120x40 and 240x70. A single-cell edit marked `[row 2, col 5..6)`, painted only that row into the retained buffer, and resulted in one native cell update and 84 terminal output bytes at both sizes. Cursor-only movement updated zero text cells. A wide glyph at the right edge was clipped to the viewport width and did not alter the following row.

The initial real-terminal screenshot review exposed that the render context expects one-based terminal cursor coordinates. The adapter now adds one to its zero-based viewport coordinates; screenshots show the cursor at the intended cell. This conversion is covered by the test-renderer cursor assertion and xterm screenshots.

The probe also verified resize under a deliberately blocked Node `Writable`, injected render failures, and real PTY close/error cleanup. Renderer and viewport disposal returned native active allocations to the pre-renderer baseline. Real PTY tests observed raw mode enabled while rendering and restored on shutdown.

The probe's row model, mock keypress handler, timing results, and terminal captures are exploratory evidence. They do not establish document integration or a release performance budget. The implementation should proceed only through the document API and typed UI/platform boundaries specified by the architecture; the spike is not production editor storage.

## Related toolchain check correction

While setting up this probe, T002 reproduced a false missing-artifact report from T001: the check searched for an `opentui` CLI under `node_modules/.bin`, although the pinned OpenTUI runtime is the platform native library. `tools/toolchain-check.ts` now checks the pinned package, finds the platform library, and loads it through public `resolveRenderLib().getBuildOptions()`. Required-present and forced-missing fixtures both behave as expected; details are in [T001 evidence](../evidence/T001.md).

## Validation record

Commands, benchmark samples, screenshot paths, PTY traces, fixture IDs, and limitations are recorded in [T002 evidence](../evidence/T002.md). Large raw artifacts are retained under `.artifacts/t002/` and are ignored by Git.
