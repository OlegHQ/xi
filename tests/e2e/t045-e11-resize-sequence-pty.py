#!/usr/bin/env python3
"""T045/E11: resize 160x50 -> 80x24 -> 60x18 -> restore, through the production CLI.
docs/plan/05-validation.md's E11 row: "No text loss or orphan focus; unified diff; hidden
layout restored." Existing coverage of this exact row was component-level only
(tests/e2e/t038-session.test.ts calls WorkbenchSession.resizeSplit() directly, not through a
real PTY resize signal); tests/e2e/t094-splitter-pty.py and t128-e22-splitter-xterm-pty.py do
real terminal resizes but only between two sizes during a live drag, not this specific
three-step shrink-to-very-small-then-restore sequence against a committed (non-dragging)
split.

This fixture: opens a vertical split, types distinguishable text, resizes through all three
named sizes in order and back to the original, and confirms at each step that the process
survives (no crash/hang), the edit made before resizing is not lost, and after returning to
the original size the split is still live and interactive (a real mouse-drag on the
separator still produces begin/move/commit events) -- i.e. the split was not silently
collapsed by shrinking to 60x18, matching "hidden layout restored".
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPLITTER = re.compile(rb"XI_WORKBENCH_SPLITTER (\{[^\r\n]*\})")


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


def read_until_count(master: int, captured: bytearray, marker: bytes, count: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while captured.count(marker) < count and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if captured.count(marker) < count:
        raise SystemExit(f"missing PTY marker {marker!r} count={count}: {captured[-6000:]!r}")


def resize(master: int, rows: int, cols: int) -> None:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t045-e11-") as temporary:
    source = Path(temporary) / "resize.txt"
    source.write_text("first\nsecond\n", encoding="utf-8")
    master, slave = pty.openpty()
    resize(slave, 50, 160)
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until_count(master, captured, b"XI_WORKBENCH_READY", 1, 10)
        os.write(master, b":vsplit\r")
        read_until_count(master, captured, b"XI_WORKBENCH_SPLIT", 1, 5)
        read_for(master, captured, 0.3)

        # Edit before resizing at all.
        os.write(master, b"AONE")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # Resize through the full named sequence and back, checking the process survives
        # at each step (no crash, no hang).
        for rows, cols in [(24, 80), (18, 60), (50, 160)]:
            resize(master, rows, cols)
            read_for(master, captured, 0.4)
            if child.poll() is not None:
                raise SystemExit(f"editor exited during resize to {cols}x{rows}: {captured[-4000:]!r}")

        # After returning to the original size, the split must still be live and
        # interactive -- not silently collapsed by 60x18. A real mouse-drag on the vertical
        # separator (column 95 for the 160-column layout with the default 28-cell sidebar: editorX 29 + 131/2) must still produce a
        # real begin/move/commit sequence, exactly as it would on a split that was never
        # resized at all (matching tests/e2e/t094-splitter-pty.py's own drag pattern).
        before_drag = len(captured)
        os.write(master, mouse(0, 95, 10))
        os.write(master, mouse(32, 102, 10))
        os.write(master, mouse(0, 102, 10, True))
        read_for(master, captured, 0.4)
        drag_events = [json.loads(m.group(1)) for m in SPLITTER.finditer(captured[before_drag:])]
        drag_actions = {event.get("action") for event in drag_events}
        if not {"begin", "commit"}.issubset(drag_actions):
            raise SystemExit(f"the split is no longer interactive after the resize sequence: {drag_events!r}\n{captured[before_drag:][-3000:]!r}")

        os.write(master, b":w\r")
        read_for(master, captured, 0.4)
        for _ in range(5):
            if child.poll() is not None:
                break
            os.write(master, b":q!\r")
            deadline = time.monotonic() + 1
            while child.poll() is None and time.monotonic() < deadline:
                read_for(master, captured, 0.05)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    final_text = source.read_text(encoding="utf-8")

expected = "firstONE\nsecond\n"
if final_text != expected:
    raise SystemExit(f"E11 resize sequence lost or corrupted the pre-resize edit: expected {expected!r}, got {final_text!r}")
print("T045-E11-RESIZE-SEQUENCE-PTY pass: 160x50 -> 80x24 -> 60x18 -> 160x50 with an active "
      "split survived cleanly; the pre-resize edit was not lost, and the split was still "
      "live and interactive (a real mouse-drag committed) after being shrunk to 60x18 and restored")
