#!/usr/bin/env python3
"""Prove the canonical root theme changes the launched Xi palette."""
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


def read_until(master: int, marker: bytes, seconds: float) -> bytearray:
    captured = bytearray()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and marker not in captured:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return captured
    return captured


with tempfile.TemporaryDirectory(prefix="xi-root-theme-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('schema-version = 1\ntheme = "xi-dark"\n[editor]\ncursorline = true\n', encoding="utf-8")
    source = root / "theme.txt"
    source.write_text("dark theme\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 60, 0, 0))
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
    captured = read_until(master, b"XI_WORKBENCH_READY", 8)
    try:
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        if b"\x1b[48;2;30;30;46m" not in captured:
            raise SystemExit(f"root theme did not paint the dark background: {captured[-4000:]!r}")
        if b"\x1b[48;2;49;50;68m" not in captured:
            raise SystemExit(f"cursorline did not paint the active row: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config root-theme PTY passed: launched Xi painted the configured dark palette.")
