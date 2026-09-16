# T006: terminal input normalization feasibility

## Decision and scope

The UI adapter consumes one canonical event for each OpenTUI key, paste, focus, blur, or hit-tested mouse callback. Key events retain protocol source and canonical press/repeat/release type; paste retains bytes rather than decoding or re-parsing them as commands; mouse coordinates are zero-based terminal cells. The parser and renderer adapters are separate because OpenTUI exposes low-level CSI focus reports as `response` events, then maps them to public renderer `focus`/`blur` events.

This is a feasibility spike, not product input code. `spikes/input/utf8-boundary.ts` demonstrates a TTY stream adapter which protects partial UTF-8 sequences before OpenTUI's parser. It uses OpenTUI's public `CliRendererConfig.stdin` port, but its `Transform`-to-`ReadStream` bridge is prototype code and must be reimplemented and owned under `packages/ui/input/` during T035.

Pinned versions: Bun 1.3.x from the checked toolchain, `@opentui/core` 0.5.11, and the isolated Neovim 0.12.4 oracle. The Kitty protocol background is documented at [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).

## Capability matrix

| Input path | Configuration / observed behavior | Limitation |
|---|---|---|
| Legacy parser | `StdinParser` with Kitty parsing disabled. A lone Escape remains pending at 19 ms and emits at the 20 ms threshold; a following `ESC x` emits Alt-x. Ctrl-C is an ordinary Ctrl-C key event. | Tab/Ctrl-I, Enter/Ctrl-M and Esc/Ctrl-[ byte collisions remain ambiguous. The 20 ms parser timeout is fixed inside the pinned CLI renderer and is not a complete key-to-screen latency guarantee. |
| Legacy renderer | Real Linux kernel PTY, `TERM=xterm-256color`, Kitty mode disabled, mouse enabled, `exitOnCtrlC:false`. The renderer emitted one event per tested key/paste/mouse report, stayed alive after Ctrl-C, then exited on `q`; raw mode and renderables were restored/disposed. | `TERM` names the advertised terminal type only; no xterm emulator, tmux, SSH or named terminal model was under test. |
| Kitty parser/renderer | Injected Kitty bytes with `disambiguate:true`, `alternateKeys:true`, and `events:true`. Escape and Alt-x are distinct; Tab and Ctrl-I are distinct; Ctrl-C press and release arrive on their respective key event channels. A Kitty repeat is normalized to `eventType:"repeat"` even though OpenTUI 0.5.11 reports `eventType:"press", repeated:true`. | The PTY injects protocol bytes; it does not prove that any particular terminal supports or acknowledges Kitty negotiation. |
| Bracketed paste | OpenTUI emits one byte-preserving paste event for `x ESC [ A LF q`; the embedded escape-looking sequence and `q` do not become key events. | Paste content decoding, invalid paste policy and editing semantics belong to later product tickets. |
| Focus | Low-level parser returns CSI response events for `ESC [ I` and `ESC [ O`. The public renderer emits focus/blur callbacks; repeated same-state reports produce no duplicate callback. | T006 tests renderer focus state only; focus restoration across suspend/resume is covered by later lifecycle work. |
| SGR mouse | Parser and renderer both report the injected left-down at terminal cell `(column0=5,row0=2)` exactly once. | Drag/release/wheel, legacy mouse limits, large coordinates and suspend restoration are owned by T084. |

OpenTUI 0.5.11 has a configuration trap: its renderer evaluates `config.useKittyKeyboard ?? {}`, so passing `null` still creates the default Kitty config instead of disabling it. The legacy probe passes an all-false options object and then calls the public `renderer.disableKittyKeyboard()` method, which updates both terminal mode and parser context. Do not infer legacy mode from `null` in this version.

The renderer defaults to exiting on Ctrl-C. Xi must set `exitOnCtrlC:false` and route Ctrl-C through the active editor context. The pinned oracle fixture `INP-ORACLE-CTRLC-01` confirms `iX<C-C>` changes `abc` to `aXbc`, places the cursor at one-based byte column 2, and returns to Normal mode without a blocking state or error.

## UTF-8 chunk boundary finding

`INP-UTF8-CHUNK-01` pushes `C3`, advances the manual clock 5 ms, then pushes `A9`; the pinned parser emits exactly one `é` key event. This proves that separate input chunks work when the parser receives them before its timeout.

`INP-UTF8-CHUNK-LATE-01` advances to the parser's 20 ms flush threshold between those bytes. OpenTUI then reports two legacy key events (`Meta+Shift+C` and the fallback derived from `A9`) instead of one character. The real renderer PTY reproduced the same result with a 25 ms gap (`legacy` run). These bytes could be mistaken for key commands, so the production adapter must keep valid UTF-8 code points intact independently of the Escape timeout.

The spike guard holds only a valid incomplete code point, emits it unchanged when complete, and emits U+FFFD text for invalid or unfinished bytes. Its fixture cases cover delayed split bytes, invalid continuation followed by ASCII, and end-of-stream. The guarded real PTY run delivered one `é` after a 25 ms gap (`legacy-guarded`). This is a candidate adapter, not a product implementation or a claim about behavior from unmodified OpenTUI.

The backlog now makes T006 an explicit dependency of T013 and T035. T035 owns the production adapter requirement: incomplete UTF-8 must not become command chords after the OpenTUI parser timeout.

## Latency trace

The PTY harness measured parent-side write to observation of an OpenTUI event marker. Each mode ran once; samples include Escape timeout, key, paste, mouse, focus, UTF-8 and quit events. These are process/PTY measurements with up to 2 ms polling granularity, not human key latency or key-to-photon measurements and not release thresholds.

| PTY path | Samples | p50 (µs) | p95 (µs) | p99 (µs) | max (µs) |
|---|---:|---:|---:|---:|---:|
| Legacy, UTF-8 gap 25 ms | 12 | 460.752 | 50,288.889 | 50,288.889 | 50,288.889 |
| Kitty, adjacent UTF-8 writes | 13 | 324.127 | 8,558.705 | 8,558.705 | 8,558.705 |
| Legacy with UTF-8 guard, gap 25 ms | 11 | 419.627 | 25,973.740 | 25,973.740 | 25,973.740 |

The long-tail samples include lone-Escape disambiguation and process scheduling. Raw inputs, emitted events, and per-event latency records are under `.artifacts/input/pty/`; the aggregate is `.artifacts/input/pty/summary.json`. The single-run tails show why the 20 ms parser timeout must not be represented as a 20 ms end-to-end response bound.
