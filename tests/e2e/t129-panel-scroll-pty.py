#!/usr/bin/env python3
"""Exercise production Explorer wheel scrolling and scrollbar drag capture (T129)."""
from __future__ import annotations

import fcntl
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
EXPLORER_REFRESH = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")


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


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-5000:]!r}")


def mouse(button: int, x: int, y: int, kind: str = "M") -> bytes:
    return f"\x1b[<{button};{x};{y}{kind}".encode("ascii")


def scroll_down(x: int, y: int) -> bytes:
    return f"\x1b[<65;{x};{y}M".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t129-scroll-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    # Explorer viewport at 120x40 (sidebar full-height, minus header+footer) holds far fewer
    # than 60 rows; the last file sorts after main.ts and must require scrolling to reach.
    for index in range(60):
        (workspace / f"z{index:03d}.txt").write_text(f"FILE_{index}\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=str(workspace),
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        # Files starts already expanded, so clicking its chevron here would collapse the
        # inline tree instead of opening it (the click toggles the section's own inline
        # visibility since Explorer/Outline moved inline under the sidebar headers); use the
        # same leader shortcut tests/e2e/t040-explorer-pty.py uses to open it instead.
        os.write(master, b" vf")
        read_until(master, captured, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, 1.0)
        def thumb_near_bottom(data: bytes) -> bool:
            # Assert movement of the bounded result window itself, rather than
            # renderer-specific ANSI cursor runs for its one-cell scrollbar. In a diff
            # frame, z030 is repainted near the top only after the window moved down.
            return re.search(rb"z03[0-9]\.txt", data) is not None

        before = len(captured)
        # Wheel-scroll down repeatedly inside the Explorer panel (column 5, any data row) until the
        # scrollbar thumb reaches the bottom of the track, proving wheel input reached this panel only.
        for _ in range(80):
            os.write(master, scroll_down(5, 10))
            read_for(master, captured, 0.01)
        read_for(master, captured, 1.0)
        if not thumb_near_bottom(bytes(captured[before:])):
            raise SystemExit(f"wheel scroll never moved the scrollbar thumb to the bottom: {captured[before:][-4000:]!r}")
        # Scroll back to the top, then drag the scrollbar thumb down with a real button-down/drag/release
        # sequence to confirm scrollbar drag capture works independently of the wheel path.
        before_up = len(captured)
        for _ in range(80):
            os.write(master, mouse(64, 5, 10))
            read_for(master, captured, 0.01)
        read_for(master, captured, 0.6)
        if re.search(rb"z00[0-9]\.txt", bytes(captured[before_up:])) is None:
            raise SystemExit(f"wheel scroll-up did not return the result window toward the top: {captured[before_up:][-4000:]!r}")
        before_drag = len(captured)
        os.write(master, mouse(0, 28, 3))
        os.write(master, mouse(32, 28, 35, "M"))  # drag motion: button 0 + the SGR motion-while-pressed flag (32)
        os.write(master, mouse(0, 28, 35, "m"))  # release
        read_for(master, captured, 0.6)
        if not thumb_near_bottom(bytes(captured[before_drag:])):
            raise SystemExit(f"scrollbar drag did not move the thumb toward the bottom: {captured[before_drag:][-4000:]!r}")
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.close(master)

print("T129-PANEL-SCROLL-PTY-01 pass: production Explorer wheel scroll and scrollbar drag reveal off-screen rows")
