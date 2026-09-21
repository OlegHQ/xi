#!/usr/bin/env python3
"""Prove -c/--config changes the launched editor instead of the default user file."""
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


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-cli-config-pty-") as temporary:
    root = Path(temporary)
    custom = root / "custom.toml"
    custom.write_text('schema-version = 1\n[editor]\nline-number = "relative"\n', encoding="utf-8")
    source = root / "source.txt"
    source.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "--", "--config", str(custom), str(source)],
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
        expected = {1: b"  1 ", 2: b"  1 ", 3: b"  2 ", 4: b"  3 "}
        for row, label in expected.items():
            marker = f"\x1b[{row};30H".encode()
            start = captured.rfind(marker)
            if start < 0 or label + b"\x1b[0m" not in captured[start:start + 200]:
                raise SystemExit(f"CLI config did not render relative line numbers at row {row}: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config CLI override PTY passed: -c applied relative line-number settings in launched Xi.")
