#!/usr/bin/env python3
"""T045: ':wa'/':qa' workspace-wide write-all/quit-all through the production CLI.

packages/workbench/commands/ex-discovery.ts declares 'wa' ("Native write-all semantics") and
'qa' ("Native close-all semantics; dirty buffers report an error.") as discoverable native Ex
commands, but investigating T045/E02 found apps/xi/src/main.ts's handleWorkbenchCommand had
zero execution wiring for either -- both silently fell through to the per-view Vim Ex parser,
which only knows about its own single document, never the whole workspace. ':wa'/':qa' were
declared and discoverable but functionally inert.

Wired: ':wa' now saves every dirty buffer across all open views/splits (not just the active
one); ':qa' refuses with a clear error when any buffer is dirty (matching its declared
detail), and ':qa!' force-quits discarding every dirty buffer.

This fixture: opens left.txt, uses the file picker to commit right.txt (which replaces the
visible leaf but leaves left.txt's buffer tracked, not closed -- production picker-commit
behavior), dirties both (switching back to left.txt via the picker's existing-buffer reuse
path), confirms ':qa' refuses while both are dirty (process stays alive, nothing written),
then ':wa' saves both dirty buffers -- including the one not currently visible -- in one
shot (confirmed on disk), and finally a fresh dirty edit + ':qa!' force-quits without saving
that last edit.
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


with tempfile.TemporaryDirectory(prefix="xi-t045-wa-qa-") as temporary:
    left = Path(temporary) / "left.txt"
    right = Path(temporary) / "right.txt"
    left.write_text("left content\n", encoding="utf-8")
    right.write_text("right content\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "left.txt"],
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
        read_for(master, captured, 1.2)  # let workspace file-index population settle

        # Open right.txt through the picker (preview + commit) -- this replaces the visible
        # leaf but leaves left.txt's buffer tracked, not closed.
        os.write(master, b" f")
        read_for(master, captured, 0.3)
        os.write(master, b"right")
        wait_for(master, captured, b"XI_PICKER_PREVIEW", 5)
        read_for(master, captured, 0.3)
        os.write(master, b"\r")
        read_for(master, captured, 0.4)

        # Dirty right.txt, then navigate the picker back onto left.txt (reusing its existing
        # buffer) and dirty that too, so two independent buffers are simultaneously dirty.
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b"RIGHT")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        os.write(master, b" f")
        read_for(master, captured, 0.3)
        os.write(master, b"left")
        read_for(master, captured, 0.5)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)

        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b"LEFT")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # ':qa' must refuse -- both files still have unsaved changes.
        os.write(master, b":qa\r")
        read_for(master, captured, 0.4)
        if child.poll() is not None:
            raise SystemExit(f"':qa' exited the process despite dirty buffers: {captured[-4000:]!r}")
        if left.read_text(encoding="utf-8") != "left content\n" or right.read_text(encoding="utf-8") != "right content\n":
            raise SystemExit("dirty buffers were written to disk before ':wa' was ever run")

        # ':wa' must save every dirty buffer across both splits in one shot.
        os.write(master, b":wa\r")
        read_for(master, captured, 0.6)
        left_after_wa = left.read_text(encoding="utf-8")
        right_after_wa = right.read_text(encoding="utf-8")
        if left_after_wa != "left contentLEFT\n" or right_after_wa != "right contentRIGHT\n":
            raise SystemExit(f"':wa' did not save both dirty buffers: left={left_after_wa!r} right={right_after_wa!r}")

        # A fresh dirty edit, then ':qa!' must force-quit discarding it without saving.
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b"UNSAVED")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    left_final = left.read_text(encoding="utf-8")
    right_final = right.read_text(encoding="utf-8")

if child.returncode != 0:
    raise SystemExit(f"':qa!' did not cleanly exit the process: returncode={child.returncode}")
if left_final != "left contentLEFT\n" or right_final != "right contentRIGHT\n":
    raise SystemExit(f"':qa!' should have discarded the final unsaved edit, but disk changed: left={left_final!r} right={right_final!r}")
print("T045-WA-QA-PTY pass: ':qa' refused with two independent dirty buffers open, ':wa' "
      "saved both -- including the one not currently visible -- in one shot, and ':qa!' "
      "force-quit discarding a later unsaved edit -- all through the production CLI")
