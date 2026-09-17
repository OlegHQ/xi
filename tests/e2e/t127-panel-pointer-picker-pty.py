#!/usr/bin/env python3
"""Exercise production picker and search panel pointer activation by stable item identity (T127)."""
from __future__ import annotations

import json
import os
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PANEL_POINTER = re.compile(rb"XI_PANEL_POINTER (\{[^\r\n]*\})")


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


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def run_picker() -> None:
    import pty
    import fcntl
    import struct
    import termios

    with tempfile.TemporaryDirectory(prefix="xi-t127-picker-") as temporary:
        workspace = Path(temporary)
        source = workspace / "main.ts"
        source.write_text("const value = 1;\n", encoding="utf-8")
        target = workspace / "zztarget.txt"
        target.write_text("PICKER_TARGET_MARKER\n", encoding="utf-8")
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
            os.write(master, b" f")
            read_until(master, captured, b"Files  >", 5)
            time.sleep(0.3)
            os.write(master, b"zztarget")
            read_until(master, captured, b"XI_PICKER_PREVIEW", 5)
            read_for(master, captured, 0.3)
            # Picker panel: left=10, top=13 at 120x40; header row occupies screen row 14 (mouse y=14),
            # first (and only, filtered) entry occupies mouse y=15.
            before = len(captured)
            os.write(master, mouse(0, 13, 15))
            os.write(master, mouse(0, 13, 15, True))
            read_for(master, captured, 0.6)
            events = [json.loads(match.group(1)) for match in PANEL_POINTER.finditer(captured[before:])]
            hit = next((event for event in events if event.get("panel") == "picker" and event.get("action") == "activate"), None)
            if hit is None:
                raise SystemExit(f"no production picker row activated by stable id: {captured[before:][-4000:]!r}")
            read_for(master, captured, 0.5)
            if b"ICKER_TARGET_MARKER" not in captured:
                raise SystemExit(f"zztarget.txt was not opened after production picker pointer activation: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)
    print("T127-PANEL-PTY-02 pass: production picker row activated zztarget.txt by stable item id and opened it in the editor")


def run_search() -> None:
    import pty
    import fcntl
    import struct
    import termios

    with tempfile.TemporaryDirectory(prefix="xi-t127-search-") as temporary:
        workspace = Path(temporary)
        (workspace / "src").mkdir()
        (workspace / "src" / "target.txt").write_text("needle from disk\n", encoding="utf-8")
        (workspace / "src" / "other.txt").write_text("different\n", encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts")],
            cwd=workspace,
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
            os.write(master, b" /")
            read_until(master, captured, b"XI_SEARCH_OPEN", 5)
            os.write(master, b"needle")
            read_until(master, captured, b'"firstPath":"src/target.txt"', 5)
            read_until(master, captured, b"needle from disk", 5)
            read_for(master, captured, 0.3)
            # Search panel: header row occupies mouse y=14, the sole file heading occupies
            # mouse y=15, its single match row occupies mouse y=16 starting at mouse x=11.
            before = len(captured)
            os.write(master, mouse(0, 11, 16))
            os.write(master, mouse(0, 11, 16, True))
            read_for(master, captured, 0.6)
            events = [json.loads(match.group(1)) for match in PANEL_POINTER.finditer(captured[before:])]
            hit = next((event for event in events if event.get("panel") == "search" and event.get("action") == "activate"), None)
            if hit is None:
                raise SystemExit(f"no production search row activated by stable id: {captured[before:][-4000:]!r}")
            read_for(master, captured, 0.5)
            if b'"path":"src/target.txt"' not in captured:
                raise SystemExit(f"src/target.txt was not opened after production search pointer activation: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)
    print("T127-PANEL-PTY-04 pass: production search row activated src/target.txt by stable item id and opened it in the editor")


run_picker()
run_search()
