#!/usr/bin/env python3
"""Exercise production workbench control hit targets and clean terminal exit."""
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
CONTROL = re.compile(rb"XI_WORKBENCH_CONTROL (\{[^\r\n]*\})")


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


with tempfile.TemporaryDirectory(prefix="xi-t094-controls-") as temporary:
    source = Path(temporary) / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM":"xterm-256color", "HOME":temporary, "XI_UI_TEST_MARKERS":"1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        # Header controls: Files, Search, Git. The status row is the last row.
        for event in (mouse(0, 3, 1), mouse(0, 3, 1, True), mouse(0, 15, 1), mouse(0, 15, 1, True), mouse(0, 25, 1), mouse(0, 25, 1, True), mouse(0, 70, 1), mouse(0, 70, 1, True), mouse(0, 20, 40), mouse(0, 20, 40, True)):
            os.write(master, event)
        read_for(master, captured, 0.5)
        controls = [json.loads(match.group(1)) for match in CONTROL.finditer(captured)]
        ids = {control.get("id") for control in controls if control.get("activated") is True}
        if not {"sidebar.files", "sidebar.search", "sidebar.git", "status"}.issubset(ids):
            raise SystemExit(f"missing production workbench controls: {controls!r}")
        read_for(master, captured, 1.0)
        for _ in range(3):
            os.write(master, b"\x1b")
            read_for(master, captured, 0.15)
        os.write(master, b"q")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"control PTY did not quit: {captured[-7000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"workbench controls exited {child.returncode}: {captured[-5000:]!r}")
    artifact = ROOT / ".artifacts/e2e/t094-controls.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({"schema_version":1, "fixture":"T094-E21-controls", "controls":controls}, indent=2) + "\n", encoding="utf-8")

print("T094 production PTY passed sidebar/status control hit targets and clean exit")
