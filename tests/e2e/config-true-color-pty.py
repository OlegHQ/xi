#!/usr/bin/env python3
"""Prove editor.true-color overrides a false terminal capability detection."""
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


def launch(root: Path, enabled: bool) -> bytes:
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(f"schema-version = 1\n[editor]\ntrue-color = {'true' if enabled else 'false'}\n", encoding="utf-8")
    source = root / ("true-color-on.txt" if enabled else "true-color-off.txt")
    source.write_text("true color\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 60, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": str(root), "TERM": "xterm-256color", "COLORTERM": "", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", "apps/xi/src/main.ts", str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    deadline = time.monotonic() + 8
    try:
        while time.monotonic() < deadline and b"XI_WORKBENCH_READY" not in captured:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {bytes(captured[-4000:])!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {bytes(captured[-4000:])!r}")
    return bytes(captured)


with tempfile.TemporaryDirectory(prefix="xi-true-color-pty-") as temporary:
    root = Path(temporary)
    reduced = launch(root / "reduced", False)
    forced = launch(root / "forced", True)
    if b'XI_COLOR_MODE {"colorMode":"ansi256"' not in reduced:
        raise SystemExit(f"terminal capability detection did not select ansi256: {reduced[-4000:]!r}")
    if b'XI_COLOR_MODE {"colorMode":"truecolor"' not in forced:
        raise SystemExit(f"true-color override did not select truecolor: {forced[-4000:]!r}")

print("T036 production PTY passed editor.true-color")
