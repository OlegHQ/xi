#!/usr/bin/env python3
"""Exercise the production OpenTUI SGR mouse path and Vim-owned gestures."""
from __future__ import annotations

import json
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import termios
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MARKER = re.compile(rb"XI_POINTER_(?:STATE|SCROLL|CANCEL) (?P<body>\{[^\r\n]*\})")


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
        raise SystemExit(f"missing PTY text {marker!r}: {captured[-5000:]!r}")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    suffix = "m" if release else "M"
    return f"\x1b[<{button};{x};{y}{suffix}".encode("ascii")


def launch(source: Path) -> bytes:
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(source.parent), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(source)],
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
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        # First cell of the first line: a normal click.
        os.write(master, mouse(0, 7, 2) + mouse(0, 7, 2, True))
        read_for(master, captured, 0.15)
        # Two clicks promote the gesture to a word selection.
        os.write(master, mouse(0, 10, 2) + mouse(0, 10, 2, True))
        os.write(master, mouse(0, 10, 2) + mouse(0, 10, 2, True))
        read_for(master, captured, 0.15)
        # Three clicks promote the gesture to a line selection.
        os.write(master, mouse(0, 7, 3) + mouse(0, 7, 3, True))
        os.write(master, mouse(0, 7, 3) + mouse(0, 7, 3, True))
        os.write(master, mouse(0, 7, 3) + mouse(0, 7, 3, True))
        read_for(master, captured, 0.15)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.1)
        # Alt-click adds a normal caret; Alt-Shift drag creates a block.
        os.write(master, mouse(8, 12, 4) + mouse(8, 12, 4, True))
        os.write(master, mouse(12, 9, 2) + mouse(44, 14, 4) + mouse(12, 14, 4, True))
        # Wheel is routed to the active view without changing keyboard focus.
        os.write(master, mouse(64, 20, 5))
        read_for(master, captured, 0.35)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.1)
        # A lost release across a terminal resize must cancel the capture.
        os.write(master, mouse(0, 8, 2))
        read_for(master, captured, 0.03)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        read_for(master, captured, 0.2)
        os.write(master, mouse(0, 12, 2, True))
        read_for(master, captured, 0.1)
        # The last pointer gesture can leave a selection (multi-click timing).
        # Exit Visual explicitly before q, which otherwise starts a Vim macro.
        os.write(master, b"\x1b")
        read_for(master, captured, 0.15)
        os.write(master, b"q")
        read_for(master, captured, 0.2)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired as error:
            read_for(master, captured, 0.1)
            raise SystemExit(f"pointer PTY quit timed out; terminal tail={captured[-5000:]!r}") from error
        if child.returncode != 0:
            raise SystemExit(f"pointer PTY child exited {child.returncode}: {captured[-5000:]!r}")
        return bytes(captured)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="xi-t086-pointer-pty-") as temporary:
    source = Path(temporary) / "pointer.txt"
    source.write_text("alpha beta gamma\nsecond line here\nthird line\nfourth line\n", encoding="utf-8")
    capture = launch(source)
    states = [json.loads(match.group("body")) for match in MARKER.finditer(capture) if b"XI_POINTER_STATE" in match.group(0)]
    scrolls = [json.loads(match.group("body")) for match in MARKER.finditer(capture) if b"XI_POINTER_SCROLL" in match.group(0)]
    kinds = [state.get("kind") for state in states]
    required = {"click", "word", "line", "add-caret", "block"}
    if not required.issubset(kinds):
        raise SystemExit(f"missing pointer kinds {sorted(required - set(kinds))}: {capture[-8000:]!r}")
    if not scrolls:
        raise SystemExit(f"missing pointer scroll marker: {capture[-8000:]!r}")
    cancels = [json.loads(match.group("body")) for match in MARKER.finditer(capture) if b"XI_POINTER_CANCEL" in match.group(0)]
    if not any(cancel.get("reason") == "resize" for cancel in cancels):
        raise SystemExit(f"missing resize capture cancellation: {capture[-8000:]!r}")
    if any(state.get("kind") in {"word", "line", "block"} and state.get("mode") != "visual" for state in states):
        raise SystemExit(f"semantic pointer selection did not enter Visual mode: {states!r}")
    if any(state.get("kind") == "add-caret" and (state.get("selectionCount", 0) < 2 or set(state.get("selectionKinds", [])) != {"normal-cursor"}) for state in states):
        raise SystemExit(f"Alt-click did not retain multiple normal cursors: {states!r}")
    artifact = ROOT / ".artifacts/e2e/t086-pointer.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({
        "schema_version": 1,
        "fixture": "T086-production-pointer-pty",
        "states": states,
        "scrolls": scrolls,
        "cancels": cancels,
        "required_kinds": sorted(required),
        "clean_exit": True,
    }, indent=2) + "\n", encoding="utf-8")

print("T086 production PTY passed click, word, line, Alt-caret, block, wheel and clean cancellation")
