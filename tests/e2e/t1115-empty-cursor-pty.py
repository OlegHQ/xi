#!/usr/bin/env python3
"""Check that a launched Xi paints its block cursor on a new empty buffer."""
from __future__ import annotations

import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_until(fd: int, marker: bytes, timeout: float) -> bytes:
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and marker not in output:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                break
    return bytes(output)


with tempfile.TemporaryDirectory(prefix="xi-empty-cursor-") as home:
    path = Path(home) / "empty.txt"
    path.write_text("")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = dict(os.environ, HOME=home, TERM="xterm-256color", COLORTERM="truecolor", XI_UI_TEST_MARKERS="1")
    env.pop("XDG_CONFIG_HOME", None)
    child = subprocess.Popen(["bun", "run", "apps/xi/src/main.ts", str(path)], cwd=ROOT, env=env,
                             stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    try:
        output = read_until(master, b"XI_WORKBENCH_READY", 8)
        if b"XI_WORKBENCH_READY" not in output:
            raise AssertionError("Xi did not reach the workbench")
        if b"\x1b[1;8H\x1b[38;2;" not in output or b"\x1b[48;2;20;32;46m" not in output:
            raise AssertionError("empty first line did not paint the block cursor cell")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
        if child.returncode != 0:
            raise AssertionError(f"Xi exited {child.returncode}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

print("T1115 empty-buffer cursor PTY passed")
