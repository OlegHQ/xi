#!/usr/bin/env python3
"""Drive the disposable T033 engine preview through a real kernel PTY."""

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
ARTIFACT = ROOT / ".artifacts" / "editor" / "t033-preview.json"
TRANSCRIPT = ROOT / ".artifacts" / "editor" / "t033-preview.ansi"
READY = b"XI_PREVIEW_READY "
RESULT = b"XI_PREVIEW_RESULT "


def resize(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))


def marker(data: bytearray, prefix: bytes) -> dict[str, object] | None:
    start = data.find(prefix)
    if start < 0:
        return None
    end = data.find(b"\r\n", start)
    if end < 0:
        return None
    value = json.loads(data[start + len(prefix) : end].decode())
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid marker {value!r}")
    return value


def main() -> None:
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    child, fd = pty.fork()
    if child == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        os.execvpe("bun", ["bun", "run", "spikes/editor/t033-preview.ts"], env)
    resize(fd)
    captured = bytearray()
    deadline = time.monotonic() + 15.0

    def read_until(prefix: bytes) -> dict[str, object]:
        while time.monotonic() < deadline:
            value = marker(captured, prefix)
            if value is not None:
                return value
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
        raise TimeoutError(f"timed out waiting for {prefix!r}; transcript={TRANSCRIPT}")

    read_until(READY)
    # i enters the shared Insert session, X is broadcast to both members,
    # Escape closes the one undo group, and Ctrl-C exits the disposable preview.
    os.write(fd, b"iX")
    time.sleep(0.08)
    os.write(fd, b"\x1b")
    time.sleep(0.08)
    os.write(fd, b"\x03")
    result = read_until(RESULT)
    TRANSCRIPT.write_bytes(captured)
    ARTIFACT.write_text(json.dumps({"ready": True, "result": result}, indent=2) + "\n", encoding="utf-8")
    _, status = os.waitpid(child, 0)
    if status != 0:
        raise RuntimeError(f"preview exited with status {status}")
    if result.get("text") != "Xalpha beta\nXalpha beta":
        raise AssertionError(f"unexpected preview text: {result!r}")
    if result.get("terminal", {}).get("restored") is not True:
        raise AssertionError(f"terminal was not restored: {result!r}")
    print(f"T033 PTY preview passed: text={result['text']!r} samples={result['localTyping']['samples']}")


if __name__ == "__main__":
    main()
