#!/usr/bin/env python3
"""Launch the first Xi workbench shell through a real kernel PTY."""

from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import termios
import time

ROOT = Path.cwd()
ARTIFACT = ROOT / ".artifacts" / "editor" / "t034-launch.json"
TRANSCRIPT = ROOT / ".artifacts" / "editor" / "t034-launch.ansi"
READY = b"XI_WORKBENCH_READY "


def resize(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))


def main() -> None:
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    child, fd = pty.fork()
    if child == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["XI_UI_TEST_MARKERS"] = "1"
        os.execvpe("bun", ["bun", "run", "xi"], env)
    resize(fd)
    captured = bytearray()
    deadline = time.monotonic() + 15.0
    ready = False
    while time.monotonic() < deadline:
        if READY in captured:
            ready = True
            break
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        captured.extend(chunk)
    if not ready:
        TRANSCRIPT.write_bytes(captured)
        raise TimeoutError(f"workbench did not become ready; transcript={TRANSCRIPT}")
    os.write(fd, b"q")
    status: int | None = None
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if chunk:
                captured.extend(chunk)
        waited, child_status = os.waitpid(child, os.WNOHANG)
        if waited == child:
            status = child_status
            break
    TRANSCRIPT.write_bytes(captured)
    if status is None:
        os.kill(child, 15)
        _, status = os.waitpid(child, 0)
    ARTIFACT.write_text(json.dumps({"ready": ready, "exitStatus": status, "terminalBytes": len(captured)}, indent=2) + "\n", encoding="utf-8")
    if status != 0:
        raise RuntimeError(f"workbench exited with status {status}")
    print(f"T034 launch PTY passed: ready={ready} terminal_bytes={len(captured)}")


if __name__ == "__main__":
    main()
