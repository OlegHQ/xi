#!/usr/bin/env python3
"""Prove :config-reload and SIGUSR1 atomically update the launched input path."""
from __future__ import annotations

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


ROOT = Path(__file__).resolve().parents[2]


def read_until(master: int, output: bytearray, marker: bytes, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while marker not in output and time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            return
    if marker not in output:
        raise SystemExit(f"missing marker {marker!r}: {output[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-config-reload-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('schema-version = 1\n\n[keys.normal]\nx = "config.reload"\n', encoding="utf-8")
    source = root / "main.txt"
    source.write_text("config reload\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl = __import__("fcntl")
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    process = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        read_until(master, output, b"XI_WORKBENCH_READY")

        config.write_text('schema-version = 1\n\n[keys.normal]\nx = "editor.mouse.toggle"\n', encoding="utf-8")
        os.write(master, b"x")
        read_until(master, output, b"XI_CONFIG_RELOAD {\"ok\":true")
        time.sleep(0.25)
        os.write(master, b"x")
        read_until(master, output, b"XI_MOUSE_MODE {\"enabled\":false}")

        config.write_text('schema-version = 1\n\n[keys.normal]\ny = "editor.mouse.toggle"\n', encoding="utf-8")
        os.kill(process.pid, signal.SIGUSR1)
        read_until(master, output, b"XI_CONFIG_RELOAD {\"ok\":true")
        time.sleep(0.25)
        os.write(master, b"y")
        read_until(master, output, b"XI_MOUSE_MODE {\"enabled\":true}")

        config.write_text('schema-version = 1\n\n[editor]\nscrolloff = "invalid"\n', encoding="utf-8")
        os.kill(process.pid, signal.SIGUSR1)
        read_until(master, output, b"XI_CONFIG_RELOAD {\"ok\":false")
        time.sleep(0.25)
        os.write(master, b"y")
        read_until(master, output, b"XI_MOUSE_MODE {\"enabled\":false}")

        os.write(master, b"q")
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)

print("T036 config-reload PTY passed command reload, SIGUSR1 reload, and last-good rollback.")
