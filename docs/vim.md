# Vim behavior

Xi owns its Vim engine. Neovim 0.12.4 is a pinned development oracle only; there is no
runtime process, library, remote connection or fallback.

Neovim is the semantic oracle for Vim modes, motions, operators, registers, repeat,
search and undo. Xi does not adopt Helix's general editing model or keybindings. Helix is
the separate 1:1 oracle for multi-selection behavior: creation, primary identity,
direction, merge/deduplication, mapping through document changes and simultaneous edits.
When the two models intersect, Vim determines the command and Helix determines how that
command is applied across the selection set.

Behavior comparisons include text, semantic cursor and desired column, mode, selection
shape, registers and types, marks, repeat/search state and undo history. UTF-8 oracle
columns are converted against the exact checkpoint document before comparison. Rendering
graphemes, Vim characters and terminal cells remain distinct coordinate spaces.

Implement semantics in the parser/motion/range/operator owner, never in the UI. For a
change, add the smallest differential fixture first, cover counts and operator/select
composition, then test a following command so latent repeat or history state is visible.
Search uses Xi's owned Vim dialect with explicit cancellation and zero-width progress.

The pinned binary, runtime hashes and generated inventory live under `tests/oracle` and
`docs/compatibility`. Personal `~/.config/nvim` is research data only and must not be
executed or modified.

## Files editing

Files keeps the expandable VS Code-style tree, including its mouse controls, indentation,
icons and decorations. Separate directory documents supply inline Vim editing; mini.files
is an editing reference, not a layout spec. `dd`, Visual `x`, counts, registers, `p`/`P`, `u`,
Ctrl-R and repeat run through the owned Vim engine. Directory registers are shared
between Files documents; their undo histories and the editor's history are separate.
Deleting a row advances to the following entry. `i` edits a name; `o`/`O` insert a new
entry row. A trailing `/` creates a directory, and nested new names create parents.

Edits are drafts. `=` opens a themed confirmation dialog for all visited directory
drafts, with Cancel selected. Tab or the arrow keys choose Cancel, Discard all or Apply; Enter
activates the selected button, and `y` applies directly. Discard all resets pending Files
edits in every visited directory without changing disk. Occupied destinations receive a free name
such as `file (copy).txt`, shown in review before Apply; existing files are preserved.
Invalid or unsafe operations block Apply. Rename previews name both original and destination paths.
Escape cancels review without applying it. In Normal mode, Escape or `q`
returns focus to the editor and preserves the drafts. Files mode appears in the main
status line; a red theme token marks pending changes and the review hint appears only
while drafts are modified. Pending rows use a themed `*` marker. Space opens the leader
menu in Files Normal mode and inserts a space during filename editing. `j`/`k` traverse
visible tree rows. Ctrl-U/Ctrl-D move and scroll
by half the Files viewport; a count sets the distance for subsequent half-page commands.
`h` collapses a folder or selects its parent; `l` expands a folder, enters its children,
or previews a file. `>` expands and `<` collapses folders in place, including selected
folders in Visual mode. Clicking a folder toggles it; clicking a file previews it.
`L`/Enter opens a file in the editor. Pasting on a folder targets that folder.
Applied deletions go to workspace trash; synchronization resets directory undo history.
Unsafe paths and deleting unsaved editor buffers are refused. Apply checks destinations
again and refuses a file that appeared after review instead of overwriting it.

`tests/workbench/explorer-mini-files.test.ts` compares text and cursor checkpoints
against pinned mini.files on the pinned Neovim development oracle. This verifies the
covered commands rather than claiming every Neovim command or mini.files feature.

## Markdown preview

In Markdown files, `Space p` toggles OpenTUI's rendered Markdown viewer in place of the
source pane. Headings, emphasis, lists, links, fenced code and tables use OpenTUI's native
Markdown component. Preview is remembered per buffer and works in split panes.

Vim motions, search, Visual selections and yanks still operate on the original document.
Vertical motions scroll the preview; `gg` and `G` reach its start and end. Rendered cells
and source selections need not coincide. Mouse selection belongs to the Markdown viewer.
Insert and Replace modes show the source; returning to Normal restores preview.
`Space p` restores the source without changing its text or undo history.

UI and render failures appear in a dialog rather than being printed over the terminal.
The preview dialog offers `Space p` to return to the source. The general UI dialog includes
the error and a retry button. Process-level fatal failures still restore the terminal and
exit through the crash handler.

## Jump history

Jump history survives normal editor exits. Xi stores up to 100 file locations in
`$XDG_STATE_HOME/xi/jumps.json` (default `~/.local/state/xi/jumps.json`). After
reopening, `Ctrl+O` returns to the last session's locations, opening files as needed;
`Ctrl+I` moves forward. Lines and columns are clamped if a file has become shorter.
Missing files report a status message; another `Ctrl+O` continues to older entries.
This saves navigation locations, not unsaved buffer contents.
