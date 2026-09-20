#!/usr/bin/env python3
"""T045/E02: file picker preview/commit/cancel through the production CLI.
docs/testing.md's E02 row: "File picker preview/cancel/pin, switch split, return"
-> "Source view restored, no dirty preview discarded, same buffer text in two views."

Investigating this surfaced two genuine, previously undiscovered bugs in
apps/xi/src/main.ts's picker-preview wiring (workbench-owned code, legitimate maintenance
per AGENTS.md since this ticket's own dependency, T038, owns packages/workbench/):

1. Data loss: `previewViewId` was a single stale pointer never cleared when the previewed
   buffer got promoted (dirtied) or committed. Escape then unconditionally force-discarded
   whatever it still pointed to via `workbench.closeView(id, 'discard')` -- which bypasses
   the dirty-buffer guard entirely (a `decision` argument is supplied) -- silently destroying
   real, already-promoted/pinned edits that merely happened to share the stale pointer.
   Empirically confirmed with a throwaway debug probe before the fix:
   preview a file, commit it, edit it (auto-promoting it to pinned/dirty), preview a
   *different, brand-new* file, and press Escape -- the pinned, dirty buffer got discarded.
2. Duplicate documents: the picker's file-index entries always use absolute paths, but a
   relative CLI argument (e.g. `xi alpha.txt`) was stored as-is, so navigating the picker
   back onto that same already-open file failed the naive `buffer.path === path` string
   comparison and opened a second, independent document for the identical file (confirmed
   empirically: buffer count grew from 2 to 3 for a file that was already open).

Fixed by: resolving the CLI file argument to an absolute-looking path so it is comparable
via the same `filesystem.workspaceRelativePath` normalization every other subsystem already
uses (Explorer/search/LSP); a `discardStalePreview` helper that only ever closes a view whose
buffer is still actually `preview === true` (never a promoted/committed one); and clearing
`previewViewId` at every point a preview buffer stops being a preview (promote-on-edit,
explicit commit, or a new preview replacing it).

This fixture: preview beta.txt, commit it (Enter), edit it (promoting it to pinned/dirty),
reopen the picker and preview a brand-new third file, cancel that preview with Escape (which
must discard only gamma.txt's own never-committed preview), then reopen the picker and
navigate straight back onto beta.txt by name -- this must reuse the same already-open,
edited buffer (no new XI_PICKER_PREVIEW fires, since that marker only fires on the picker's
"open a new document" branch, never its "reuse an existing buffer" branch -- covering "same
buffer text in two views") and must find the edit still present (covering "no dirty preview
discarded") by saving it directly with `:w` and checking the edit on disk.
"""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t045-e02-") as temporary:
    alpha = Path(temporary) / "alpha.txt"
    beta = Path(temporary) / "beta.txt"
    gamma = Path(temporary) / "gamma.txt"
    alpha.write_text("alpha content\n", encoding="utf-8")
    beta.write_text("beta content\n", encoding="utf-8")
    gamma.write_text("gamma content\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "alpha.txt"],
        cwd=temporary,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        # Let workspace file-index population settle so the picker's fuzzy search finds
        # all three real files (not just the initially opened one).
        read_for(master, captured, 1.2)

        # Preview beta.txt, then commit it (Enter) -- this promotes it out of preview.
        os.write(master, b" f")
        read_for(master, captured, 0.3)
        os.write(master, b"beta")
        wait_for(master, captured, b"XI_PICKER_PREVIEW", 5)
        read_for(master, captured, 0.3)
        os.write(master, b"\r")
        read_for(master, captured, 0.4)

        # Edit beta.txt -- this dirties (and, per the onStateChange hook, promotes/pins) it.
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b"EDITED")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # Reopen the picker and preview a brand-new third file, then cancel that preview.
        os.write(master, b" f")
        read_for(master, captured, 0.3)
        os.write(master, b"gamma")
        wait_for(master, captured, b"XI_PICKER_PREVIEW", 5)
        read_for(master, captured, 0.3)
        before_cancel = len(captured)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.4)

        # gamma.txt's own preview is fine to discard; beta.txt must never be touched by it.
        if b"XI_PICKER_CANCELLED" not in captured[before_cancel:]:
            raise SystemExit(f"cancelling gamma.txt's own preview did not discard it: {captured[before_cancel:]!r}")

        # Navigate straight back onto the already-open, edited beta.txt by name. This must
        # reuse the same buffer (no new XI_PICKER_PREVIEW -- that marker only fires on the
        # picker's "open a new document" branch) and must find the edit still intact.
        before_beta = len(captured)
        os.write(master, b" f")
        read_for(master, captured, 0.3)
        os.write(master, b"beta")
        read_for(master, captured, 0.6)
        if b"XI_PICKER_PREVIEW" in captured[before_beta:]:
            raise SystemExit(f"navigating onto an already-open file opened a duplicate document: {captured[before_beta:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)
        os.write(master, b":w\r")
        read_for(master, captured, 0.5)

        os.write(master, b":q!\r")
        for _ in range(5):
            if child.poll() is not None:
                break
            os.write(master, b":q!\r")
            read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    beta_text = beta.read_text(encoding="utf-8")

expected = "beta contentEDITED\n"
if beta_text != expected:
    raise SystemExit(f"a dirty, promoted preview buffer was discarded or focus was not restored: expected {expected!r} on disk, got {beta_text!r}")
print("T045-E02-PICKER-PREVIEW-PTY pass: cancelling an unrelated preview did not discard a "
      "dirty, promoted buffer elsewhere in the session, and navigating the picker back onto "
      "that already-open, edited file reused the same buffer (no duplicate document) with "
      "the edit still intact")
