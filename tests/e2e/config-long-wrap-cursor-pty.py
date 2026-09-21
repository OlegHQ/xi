#!/usr/bin/env python3
"""A cursor moved deep into one wrapped line remains visible in the real terminal."""
from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]


def read_until(master: int, stderr: int, screen: Screen, diagnostics: bytearray, predicate, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        for descriptor in select.select([master, stderr], [], [], 0.05)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                continue
            if descriptor == master:
                screen.feed(data)
            else:
                diagnostics.extend(data)
    if not predicate():
        raise SystemExit(f"terminal did not show expected cells: rows={[screen.row_text(row) for row in range(1, screen.rows + 1)]!r}; stderr={diagnostics[-1000:]!r}")


def target_visible(screen: Screen) -> bool:
    return any("ARGET" in screen.row_text(row) for row in range(1, screen.rows + 1))


with tempfile.TemporaryDirectory(prefix="xi-long-wrap-cursor-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor.soft-wrap]\nenable = true\n', encoding="utf-8")
    source = root / "long.txt"
    source.write_text("x" * 450 + "TARGET" + "x" * 120 + "\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 40, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=root, env=environment,
                             stdin=slave, stdout=slave, stderr=subprocess.PIPE, close_fds=True)
    os.close(slave)
    diagnostics = bytearray()
    screen = Screen(14, 40)
    assert child.stderr is not None
    try:
        read_until(master, child.stderr.fileno(), screen, diagnostics, lambda: b"XI_WORKBENCH_READY" in diagnostics, 10)
        if target_visible(screen):
            raise SystemExit("distant target was already painted before motion")
        os.write(master, b"450l")
        read_until(master, child.stderr.fileno(), screen, diagnostics, lambda: target_visible(screen), 8)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 42, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        screen = Screen(12, 42)
        read_until(master, child.stderr.fileno(), screen, diagnostics, lambda: target_visible(screen), 8)
        os.write(master, b"q")
        child.wait(timeout=6)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {diagnostics[-1000:]!r}")

print("Long soft-wrap cursor PTY passed: deep motion and resize keep target visible")
