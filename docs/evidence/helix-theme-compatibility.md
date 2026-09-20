# Helix theme compatibility

- Ticket ID and title: user-requested Helix theme-system rebuild
- Outcome: passed schema, catalog, startup and implemented Xi-surface compatibility
- Implementation revision or tree hash: base `f90db5c` plus the uncommitted working tree
- Environment and pinned dependency/oracle versions: Bun 1.3.13; OpenTUI dependencies pinned by this repository; Helix `079a789e8cb08ead67f19e1971a1b7438b37354b` (current upstream HEAD when validated)
- Specification sections and acceptance items covered: `docs/plan/06-execution.md` panel/theme validation route; `docs/plan/01-architecture.md` configuration and UI ownership

## Observable result

Xi accepts Helix theme scopes, palette aliases, numeric terminal colours, inline style tables (including multiline tables and dotted underline properties), `rainbow` style arrays, documented modifiers, underline data and inheritance. Terminal names use Helix's exact ANSI slots (`gray` is bright black and `light-gray` is normal white), and only `#RGB`/`#RRGGBB` hex forms are accepted. The startup configuration can select a custom theme; it loads only that file and its parent chain before the first frame. The picker discovers the full catalog after the first frame.

All 218 current Helix runtime themes plus expanded `default.toml` and `base16_default.toml` were installed in `~/.config/xi/themes` (220 files total). The UI retains the fully resolved scope map, maps chrome/panel/editor/diff surfaces to Helix UI scopes, and paints syntax foregrounds, backgrounds and supported terminal attributes. Tree-sitter capture scopes remain exact through the service-to-renderer boundary, where longest-match Helix lookup selects their style.

| Helix scope family | Xi consumer |
|---|---|
| `ui.background`, `ui.text`, `ui.gutter`, `ui.linenr*`, `ui.selection*`, `ui.highlight`, `ui.cursor*`, `ui.cursorline*`, `ui.cursorcolumn*` | editor paint and cursor/motion layers |
| `ui.statusline*`, `ui.bufferline*`, `ui.window`, `ui.background.separator` | status line, tabs and split/sidebar chrome |
| `ui.menu*`, `ui.menu.scroll`, `ui.picker.header`, `ui.popup*`, `ui.help`, `ui.text.directory`, `ui.text.focus`, `ui.text.inactive`, `ui.text.info` | picker, explorer, search, Git, outline, hierarchy, completion, command, hover, context and prefix-help panels |
| `diagnostic.*`, `error`, `warning`, `info`, `hint`, `diff.*` | problems rows and Git diff/editor rows |
| `markup.normal.hover`, `markup.heading.hover`, `markup.raw.inline.hover` | hover prose, headings and inline/code spans |
| `ui.virtual*`, `ui.debug.*` and unrecognised future scopes | retained in the resolved scope map for their matching feature; no current Xi widget emits those feature states |

## Executed validation

| Command / fixture | Actual result | Evidence path / retained CI artifact |
|---|---|---|
| Installed-theme parse and discovery sweep | 220 themes, 0 diagnostics through `NodeFilesystemPort` | command output from this run |
| `bun run check` | passed toolchain, strict TypeScript, public-boundary and lint checks | command output from this run |
| `bun test tests/config/helix-theme-compatibility.test.ts` | passed inheritance, palette, multiline style, dotted underline, terminal-palette intent, schema enumeration and lazy configured-load checks | `tests/config/helix-theme-compatibility.test.ts` |
| `bun test tests/syntax/bundled-languages.test.ts` | passed all bundled grammars and verified emitted spans retain their Tree-sitter capture scope | `tests/syntax/bundled-languages.test.ts` |
| `bun run test:ui` | passed all 20 UI fixtures, including exact syntax scopes, Helix curl underline cell attributes, selected/header modifiers, bufferline underline shape, editor UI scopes, terminal indexed/default colours and panel surface matrices | `.artifacts/ui/t063-contrast.json`, `.artifacts/ui/t063-frame-matrix.json` |
| `zig build test -Dtest-filter=Helix --summary all` | 3/3 passed against the owned OpenTUI fork; verifies styled-text propagation, curl/dotted/dashed SGR forms, literal/indexed/default underline colours, distinct slow/rapid blink output, link round trips, overwrite cleanup, and the unchanged 24-byte normal cell representation | `vendor/opentui/packages/native/src/tests/renderer_test.zig`, `vendor/opentui/packages/native/src/tests/text-buffer-drawing_test.zig` |
| focused OpenTUI core/Solid tests | 84 core tests passed, including the 56-byte plain styled-chunk ABI, sparse underline-colour call and borrowed-pointer lifetime; the Solid reactive style test passed and proves removed theme attributes do not stick while intrinsic modifiers remain | `vendor/opentui/packages/core/src/tests/ffi-borrowed-pointer-callsites.test.ts`, `vendor/opentui/packages/core/src/renderables/TextNode.test.ts`, `vendor/opentui/packages/solid/tests/text-style-update.test.tsx` |
| `bun run test:native` in `vendor/opentui/packages/core` | 2,169 passed, 8 skipped, 2 crashed; both crashes are the X11 delayed-INCR clipboard tests and reproduce at the unmodified fork base `63b26f7` | `/tmp/xi-opentui-native-full-theme-final.log`, `/tmp/xi-opentui-baseline-x11.log` |
| renderer-overhead benchmark, owned fork versus `63b26f7` | final candidate/baseline 10k-cell average: no-change 47.1/48.6 µs; one-change 47.3/49.1 µs; full-change 231.2/225.2 µs. The full-change delta (+2.7%) is inside the baseline's 4.13% relative margin of error; ordinary no/one-change paths improved in this sample. | `/tmp/xi-opentui-candidate-renderer-bench-theme-final.json`, `/tmp/xi-opentui-baseline-renderer-bench.json` |
| styled-text fast-path paired samples | six-chunk candidate/baseline median 2.066/2.403 µs across seven alternating runs; 100-chunk candidate/baseline median 24.574/24.451 µs across five runs (+0.5%). Plain chunks keep the original ABI and entrypoint. | `/tmp/xi-candidate-parallel-paired-small-*.json`, `/tmp/xi-baseline-parallel-paired-small-*.json`, `/tmp/xi-candidate-parallel-styled-100-*.json`, `/tmp/xi-baseline-styled-100-*.json` |
| `python3 tests/e2e/t132-custom-theme-pty.py` | passed invalid-theme recovery, discovery, picker preview, configured startup selection and fallback through the production CLI | `tests/e2e/t132-custom-theme-pty.py` |

## Performance and visual evidence

Configured startup reads only the named theme and its inheritance chain; the compatibility fixture asserts the exact two-file child/parent case. The full 220-theme scan is deferred until after the first frame for picker population. The UI suite's render-count and syntax snapshot-reuse fixtures passed. No separate timing distribution was collected for this theme-only change.

## Failure cases and recovery

Malformed themes are diagnosed and skipped without blocking startup. Missing configured themes retain the active builtin theme. Missing parents and inheritance cycles are diagnosed. Configured identifiers are constrained to simple theme file names before filesystem access.

## Limitations and next action

The checked-out Linux/arm64 OpenTUI fork emits Helix `curl`, `dashed`, `dotted` and `double_line` underline shapes, slow and rapid blink, and literal, indexed and terminal-default underline colours, while storing colour only for decorated cells. Blink and hidden text remain terminal-capability dependent. Terminal palette names retain indexed/default-colour intent and are converted to OpenTUI indexed/default colours at the UI boundary. Packed link IDs retain 65,536 live slots; a slot is retired before its four-bit generation wraps so stale IDs cannot become valid again.

`bufferSetUnderlineColor` and `textBufferSetStyledTextWithUnderlineColors` are native ABI additions. The current Bun `patchedDependencies` mechanism patches JavaScript only and cannot replace the published per-platform shared libraries. A release must therefore publish matching owned platform packages before a fresh registry install can claim this feature. This checkout uses rebuilt Linux/arm64 library SHA-256 `e1652d0ab20c2c1c23df7a50c54c9445c7496af0197f15fd3cbc7029cdac4681`; other platforms remain unqualified.
