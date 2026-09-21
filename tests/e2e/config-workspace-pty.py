#!/usr/bin/env python3
"""Prove a workspace .helix/config.toml is loaded by the launched editor."""
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


with tempfile.TemporaryDirectory(prefix="xi-workspace-config-pty-") as temporary:
    root = Path(temporary)
    (root / ".helix").mkdir()
    (root / ".helix" / "config.toml").write_text('[editor]\nline-number = "relative"\n', encoding="utf-8")
    source = root / "workspace.txt"
    source.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")

    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    def launch() -> tuple[subprocess.Popen[bytes], int, bytearray]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
        child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
            cwd=root,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
        os.close(slave)
        captured = bytearray()
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        return child, master, captured

    child, master, captured = launch()
    try:
        os.write(master, b":workspace-trust\r")
        read_for(master, captured, 2)
        if b'XI_CONFIG_RELOAD {"ok":true' not in captured:
            raise SystemExit(f"workspace trust command did not reload config: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi trust session exited {child.returncode}: {captured[-4000:]!r}")

    child, master, captured = launch()
    try:
        read_for(master, captured, 1)
        if b"  1 " not in captured or b"  2 " not in captured:
            raise SystemExit(f"trusted workspace config did not reach relative line numbers: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi trusted session exited {child.returncode}: {captured[-4000:]!r}")

print("Workspace config PTY passed: .helix/config.toml reached the launched editor.")
