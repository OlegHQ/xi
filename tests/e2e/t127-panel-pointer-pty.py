#!/usr/bin/env python3
"""Exercise production panel pointer activation by stable item identity (T127)."""
from __future__ import annotations

import json
import os
import fcntl
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
PANEL_POINTER = re.compile(rb"XI_PANEL_POINTER (\{[^\r\n]*\})")
EXPLORER_OPEN = re.compile(rb"XI_EXPLORER_OPEN (\{[^\r\n]*\})")
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


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t127-panel-pointer-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    target = workspace / "target.txt"
    target.write_text("PANEL_POINTER_TARGET_MARKER\n", encoding="utf-8")
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
        # Open the Explorer through the same leader shortcut tests/e2e/t040-explorer-pty.py
        # uses (Files starts already expanded, so clicking its chevron would collapse the
        # inline tree instead of opening it -- the click toggles the section's own inline
        # visibility now that Explorer nests under the sidebar's `▾ Files` header).
        os.write(master, b" vf")
        read_until(master, captured, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, 1.0)
        refreshes = [json.loads(match.group(1)) for match in EXPLORER_REFRESH.finditer(captured)]
        if not any(entry.get("selectedPath") is not None or entry.get("state") == "ready" for entry in refreshes):
            raise SystemExit(f"explorer root never became ready: {refreshes!r}")
        # Row 3 (mouse coords) is the expanded root (row 2 is the panel's own "N items"
        # header, nested inline under the sidebar's `▾ Files` header at row 1); children
        # start at row 4. Probe rows until the target file activates -- starting at row 3
        # would toggle the root directory closed instead of activating a file.
        target_item_id = None
        for row in range(4, 9):
            before = len(captured)
            os.write(master, mouse(0, 5, row))
            os.write(master, mouse(0, 5, row, True))
            read_for(master, captured, 1.0)
            events = [json.loads(match.group(1)) for match in PANEL_POINTER.finditer(captured[before:])]
            hit = next((event for event in events if event.get("panel") == "explorer" and event.get("action") == "activate"), None)
            if hit is None:
                continue
            read_for(master, captured, 0.5)
            if b"ANEL_POINTER_TARGET_MARKER" in captured:
                target_item_id = hit["itemId"]
                break
        if target_item_id is None:
            raise SystemExit(f"no production explorer row activated target.txt by stable id: {captured[-6000:]!r}")
        screen = captured.decode("utf-8", errors="replace")
        if "ANEL_POINTER_TARGET_MARKER" not in screen:
            raise SystemExit(f"target.txt was not opened in the editor after production pointer activation: {screen[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.close(master)

print("T127-PANEL-PTY-01 pass: production explorer row activated target.txt by stable item id and opened it in the editor")
