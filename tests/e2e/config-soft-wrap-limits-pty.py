#!/usr/bin/env python3
"""Prove configured soft-wrap limits change launched Xi row geometry."""
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
from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-soft-wrap-limits-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "schema-version = 1\n[editor.soft-wrap]\nenable = true\nmax-wrap = 0\nmax-indent-retain = 0\nwrap-indicator = \"\"\n",
        encoding="utf-8",
    )
    source = root / "soft-wrap-limits.txt"
    source.write_text("1234567890123456789012345678901234 abc\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 40, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
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
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        read_for(master, captured, 0.5)
        screen = Screen(14, 40)
        screen.feed(captured)
        if "123456789012345678901234567890123" not in screen.row_text(1) or "4 abc" not in screen.row_text(2):
            raise SystemExit(f"max-wrap=0 did not split at the viewport edge: {screen.row_text(1)!r}, {screen.row_text(2)!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config soft-wrap limits PTY passed: launched Xi honored max-wrap and split the configured word at the viewport edge.")
