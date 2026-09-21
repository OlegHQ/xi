#!/usr/bin/env python3
"""Prove editor.cursor-shape.normal changes the launched terminal cursor."""
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


with tempfile.TemporaryDirectory(prefix="xi-cursor-shape-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.cursor-shape]\nnormal = \"bar\"\ninsert = \"underline\"\nselect = \"underline\"\n", encoding="utf-8")
    source = root / "cursor-shape.txt"
    source.write_text("cursor shape\n", encoding="utf-8")

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
        if b"\x1b[6 q" not in captured:
            raise SystemExit(f"normal bar cursor was not emitted: {captured[-4000:]!r}")
        os.write(master, b"i")
        captured.extend(read_until(master, b"\x1b[4 q", 3))
        if b"\x1b[4 q" not in captured:
            raise SystemExit(f"insert underline cursor was not emitted: {captured[-4000:]!r}")
        os.write(master, b"\x1b")
        os.write(master, b"v")
        captured.extend(read_until(master, b"\x1b[4 q", 3))
        if b"\x1b[4 q" not in captured:
            raise SystemExit(f"select underline cursor was not emitted: {captured[-4000:]!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config cursor-shape PTY passed: launched Xi emitted configured cursors for normal, insert and select modes.")
