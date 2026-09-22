#!/usr/bin/env python3
"""Prove :config-open opens the user's config.toml on the launched Xi path."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-config-open-pty-") as temporary:
    root = Path(temporary)
    config = root / "xdg" / "xi" / "config.toml"
    (root / "main.txt").write_text("text\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(root / "xdg"), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
        os.write(master, b":config-open")
        read_until(master, captured, b'"source":":config-open"', 5)
        os.write(master, b"\r")
        expected = f'XI_CONFIG_OPEN {{"path":"{config}"'.encode()
        read_until(master, captured, expected, 5)
        if expected not in captured:
            raise SystemExit(f":config-open did not open the user config\n{captured[-4000:]!r}")
        if not config.is_file() or config.read_bytes() != b"":
            raise SystemExit(":config-open did not safely create the absent XDG config file")
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {bytes(captured[-4000:])!r}")

print("T036 production PTY passed config-open")
