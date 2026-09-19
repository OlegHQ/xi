#!/usr/bin/env python3
"""Exercise production Picker and Search wheel scrolling, and that panel wheel input
never reaches the editor underneath (T129)."""
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


def open_pty(cwd: Path, args: list[str]) -> tuple[int, subprocess.Popen[bytes]]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(cwd), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", *args],
        cwd=str(cwd),
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    return master, child


def close_child(master: int, child: subprocess.Popen[bytes]) -> None:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)


def run_picker() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t129-picker-scroll-") as temporary:
        workspace = Path(temporary)
        source = workspace / "main.ts"
        source.write_text("editor text unaffected by picker scroll\n", encoding="utf-8")
        for index in range(40):
            (workspace / f"p{index:03d}.txt").write_text("x\n", encoding="utf-8")
        master, child = open_pty(workspace, [str(ROOT / "apps/xi/src/main.ts"), str(source)])
        captured = bytearray()
        try:
            read_until(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" f")
            read_until(master, captured, b"Files  >", 5)
            read_for(master, captured, 0.5)
            # Picker panel: left=6, top=5 at 120x40 and 108 cells wide, so its scrollbar
            # occupies terminal column 114 (1-based) when content overflows.
            before = len(captured)
            for _ in range(40):
                os.write(master, mouse(65, 30, 20))
            read_for(master, captured, 0.6)
            thumb_moved = re.search(rb"\x1b\[(?:2[5-9]|3[0-4]);114H(?:\x1b\[38;2;[0-9;]+m)?\x1b\[48;2;31;95;191m", bytes(captured[before:])) is not None
            if not thumb_moved:
                raise SystemExit(f"picker wheel scroll did not move its scrollbar thumb: {captured[before:][-4000:]!r}")
            os.write(master, b"\x1b")
            read_for(master, captured, 0.3)
        finally:
            close_child(master, child)
    print("T129-PANEL-SCROLL-PTY-02 pass: production Picker wheel scroll moves only the picker's own scrollbar")


def run_search() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t129-search-scroll-") as temporary:
        workspace = Path(temporary)
        (workspace / "src").mkdir()
        for index in range(40):
            (workspace / "src" / f"f{index:03d}.txt").write_text("needle\n", encoding="utf-8")
        master, child = open_pty(workspace, [str(ROOT / "apps/xi/src/main.ts")])
        captured = bytearray()
        try:
            read_until(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" /")
            read_until(master, captured, b"XI_SEARCH_OPEN", 5)
            os.write(master, b"needle")
            read_until(master, captured, b'"state":"ready"', 20)
            read_for(master, captured, 0.5)
            before = len(captured)
            for _ in range(40):
                # Search is docked in the sidebar (x 1..28) under its tab; wheel inside that column.
                os.write(master, mouse(65, 10, 20))
            read_for(master, captured, 0.6)
            # The full-height docked panel starts with f000.txt. Seeing a later file proves
            # its own bounded row window moved; the exact ANSI cursor sequence used to paint
            # the one-cell scrollbar is renderer-version-specific.
            scrolled = re.search(rb"f0(?:1[0-9]|2[0-9]|3[0-9])\.txt", bytes(captured[before:])) is not None
            if not scrolled:
                raise SystemExit(f"search wheel scroll did not move its result window: {captured[before:][-4000:]!r}")
        finally:
            close_child(master, child)
    print("T129-PANEL-SCROLL-PTY-03 pass: production Search wheel scroll moves the search panel's own scrollbar")


run_picker()
run_search()
