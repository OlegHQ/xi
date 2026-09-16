#!/usr/bin/env python3
"""Exercise nested production splitters, minimum panes and capture cancellation."""
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
POINTER_CANCEL = re.compile(rb"XI_POINTER_CANCEL (\{[^\r\n]*\})")


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


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t094-splitter-pty-") as temporary:
    source = Path(temporary) / "split.txt"
    source.write_text("alpha\nbeta\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
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
    captured = bytearray()
    try:
        read_until_count(master, captured, b"XI_WORKBENCH_READY", 1, 10)
        os.write(master, b":vsplit\r")
        read_until_count(master, captured, b"XI_WORKBENCH_SPLIT", 1, 5)
        os.write(master, b":split\r")
        read_until_count(master, captured, b"XI_WORKBENCH_SPLIT", 2, 5)
        read_for(master, captured, 0.35)

        # Begin on the root vertical separator, cross the nested horizontal
        # separator, and release there. Capture must stay with the root split.
        os.write(master, mouse(0, 76, 10) + mouse(0, 83, 20) + mouse(0, 83, 20, True))
        read_for(master, captured, 0.35)

        # A proposed 10-cell pane violates the 12-cell minimum and is rejected.
        os.write(master, mouse(0, 83, 10) + mouse(0, 42, 10) + mouse(0, 42, 10, True))
        read_for(master, captured, 0.25)

        # Resize during a live drag cancels capture and restores its initial ratio.
        os.write(master, mouse(0, 83, 10) + mouse(0, 95, 10))
        read_for(master, captured, 0.08)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        read_for(master, captured, 0.5)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        read_for(master, captured, 0.4)

        # Escape cancels another live drag and leaves the committed ratio intact.
        os.write(master, mouse(0, 83, 10) + mouse(0, 95, 10))
        read_for(master, captured, 0.1)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)

        # Every view shares the document owner; edit through one view and save.
        os.write(master, b"iX")
        read_for(master, captured, 0.15)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.15)
        os.write(master, b":w\r")
        read_for(master, captured, 0.35)
        for expected_closed in (1, 2):
            os.write(master, b":q!\r")
            read_until_count(master, captured, b"XI_WORKBENCH_VIEW_CLOSED", expected_closed, 5)
            read_for(master, captured, 0.15)
        os.write(master, b":q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
    final_text = source.read_text(encoding="utf-8")

events = [json.loads(match.group(1)) for match in SPLITTER.finditer(captured)]
cancels = [json.loads(match.group(1)) for match in POINTER_CANCEL.finditer(captured)]
actions = [event.get("action") for event in events]
commits = [event for event in events if event.get("action") == "commit"]
small_moves = [event for event in events if event.get("action") == "move" and event.get("firstSize", 99) < 12]
required = {"begin", "move", "commit", "cancel"}
markers = {
    "ready": b"XI_WORKBENCH_READY" in captured,
    "splitCount": captured.count(b"XI_WORKBENCH_SPLIT"),
    "closedCount": captured.count(b"XI_WORKBENCH_VIEW_CLOSED"),
    "actions": actions,
    "resizeCancelled": any(cancel.get("reason") == "resize" for cancel in cancels),
    "smallMovesAccepted": len(small_moves),
    "commits": commits,
    "exitCode": child.returncode,
    "bytes": len(captured),
}
artifact = ROOT / ".artifacts/e2e/t094-splitter.json"
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.write_text(json.dumps({"schema_version": 1, "fixture": "T094-E22-splitter", "markers": markers, "events": events, "pointerCancels": cancels}, indent=2) + "\n", encoding="utf-8")
(ROOT / ".artifacts/e2e/t094-splitter.ansi").write_bytes(captured)
if (child.returncode != 0 or not required.issubset(actions) or not markers["resizeCancelled"]
        or markers["splitCount"] < 2 or markers["closedCount"] < 2
        or markers["smallMovesAccepted"] != 0 or final_text != "Xalpha\nbeta\n"):
    raise SystemExit(f"T094 splitter PTY failed: {markers}, text={final_text!r}\n{captured[-8000:]!r}")
print("T094 splitter PTY passed nested capture, minimum rejection, resize/Escape rollback, shared edit and close")
