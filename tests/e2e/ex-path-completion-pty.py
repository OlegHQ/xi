#!/usr/bin/env python3
"""Complete :e path components through the launched editor and open the result."""
from __future__ import annotations

import os
import pty
import select
import fcntl
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]


def wait_for(master: int, output: bytearray, marker: bytes, seconds: float = 5) -> None:
    deadline = time.monotonic() + seconds
    while marker not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
    if marker not in output:
        raise SystemExit(f"missing {marker!r}: {output[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-ex-path-") as temporary:
    workspace = Path(temporary)
    (workspace / "alpine").mkdir()
    (workspace / "alpine" / "deep.txt").write_text("DEEP_TARGET_MARKER\n", encoding="utf-8")
    (workspace / "alpha.txt").write_text("ALPHA_TARGET_MARKER\n", encoding="utf-8")
    (workspace / ".home-only.txt").write_text("HOME_TARGET_MARKER\n", encoding="utf-8")
    (workspace / "with space.txt").write_text("SPACE_TARGET_MARKER\n", encoding="utf-8")
    (workspace / "nested").mkdir()
    source = workspace / "nested" / "start.txt"
    source.write_text("start\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(workspace / ".config"), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = bytearray()
    try:
        wait_for(master, output, b"XI_WORKBENCH_READY", 10)
        os.write(master, b":e al")
        wait_for(master, output, b"alpine/")
        wait_for(master, output, b"alpha.txt")
        screen = Screen(24, 80)
        screen.feed(output)
        if "alpine/" not in screen.row_text(23) or "alpha.txt" not in screen.row_text(23) or ":e al" not in screen.row_text(24):
            raise SystemExit(f"path candidates or command prompt were misplaced: {screen.row_text(23)!r}; {screen.row_text(24)!r}")
        os.write(master, b"\t")
        wait_for(master, output, b'"source":":e alpine/"')
        os.write(master, b"deep.txt\r")
        wait_for(master, output, b'XI_NATIVE_JUMP {"path":"' + str(workspace / "alpine" / "deep.txt").encode())
        wait_for(master, output, b"EEP_TARGET_MARKER")
        os.write(master, b":e alpha\t")
        wait_for(master, output, b'"source":":e alpha.txt"')
        os.write(master, b"\r")
        wait_for(master, output, b'XI_NATIVE_JUMP {"path":"' + str(workspace / "alpha.txt").encode())
        os.write(master, b":e ~/.home\t")
        wait_for(master, output, b'"source":":e ~/.home-only.txt"')
        os.write(master, b"\r")
        wait_for(master, output, b'XI_NATIVE_JUMP {"path":"' + str(workspace / ".home-only.txt").encode())
        os.write(master, b":e with \t")
        wait_for(master, output, b'"source":":e with space.txt"')
        os.write(master, b"\r")
        wait_for(master, output, b'XI_NATIVE_JUMP {"path":"' + str(workspace / "with space.txt").encode())
        if child.poll() is not None:
            raise SystemExit("Xi exited while completing and opening :e path")
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {output[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

print(":e path completion PTY passed directory and file suggestions, Tab continuation, and open")
