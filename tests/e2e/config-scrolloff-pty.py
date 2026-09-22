#!/usr/bin/env python3
"""Prove editor.scrolloff reaches the launched Xi viewport through a real PTY."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANCHOR = re.compile(rb"XI_VIEWPORT_ANCHOR (\{[^\r\n]*\})")
SIZE = re.compile(rb"XI_VIEWPORT_SIZE (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        captured.extend(chunk)


with tempfile.TemporaryDirectory(prefix="xi-scrolloff-pty-") as temporary:
    root = Path(temporary)
    config = root / "config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor]\nscrolloff = 3\n", encoding="utf-8")
    source = root / "scrolloff.txt"
    source.write_text("\n".join(f"line-{index}" for index in range(40)) + "\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl = struct.pack("HHHH", 14, 100, 0, 0)
    import fcntl as fcntl_module
    fcntl_module.ioctl(slave, termios.TIOCSWINSZ, fcntl)
    environment = os.environ.copy()
    environment.update({
        "HOME": temporary,
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "TERM": "xterm-256color",
        "XI_UI_TEST_MARKERS": "1",
    })
    process = subprocess.Popen(
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
        os.write(master, b"15G")
        read_for(master, captured, 1)
        sizes = [json.loads(match.group(1)) for match in SIZE.finditer(captured)]
        anchors = [json.loads(match.group(1)) for match in ANCHOR.finditer(captured)]
        if not sizes or not anchors:
            raise SystemExit(f"missing viewport evidence: sizes={sizes!r} anchors={anchors!r}")
        height = sizes[-1]["heightCells"]
        anchor = next((item for item in reversed(anchors) if item.get("scrolloff") == 3 and item.get("scrollTop", 0) > 0), None)
        if anchor is None:
            raise SystemExit(f"configured scrolloff did not reach the viewport: {anchors!r}")
        bottom = min(3, height // 2)
        expected = max(0, 14 - height + bottom + 1)
        if anchor["scrollTop"] != expected:
            raise SystemExit(f"unexpected scrolloff anchor: height={height} expected={expected} anchor={anchor!r}")
        os.write(master, b"q")
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
    if process.returncode != 0:
        raise SystemExit(f"Xi exited {process.returncode}: {captured[-4000:]!r}")

print("Config scrolloff PTY passed: launched Xi applied the configured cursor margin to its viewport anchor.")
