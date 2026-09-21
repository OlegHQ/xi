#!/usr/bin/env python3
"""Prove Helix editor.scroll-lines changes a launched Xi view command."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMMAND = re.compile(rb"XI_VIEW_COMMAND (\{[^\r\n]*\})")


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


with tempfile.TemporaryDirectory(prefix="xi-scroll-lines-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor]\nscrolloff = 0\nscroll-lines = 2\n\n[keys.normal]\ng = \"view.scroll-down\"\n", encoding="utf-8")
    source = root / "scroll-lines.txt"
    source.write_text("\n".join(f"line-{index}" for index in range(30)) + "\n", encoding="utf-8")
    master, slave = pty.openpty()
    import fcntl
    import struct
    import termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", "apps/xi/src/main.ts", str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        os.write(master, b"g")
        read_for(master, captured, 1)
        commands = [json.loads(match.group(1)) for match in COMMAND.finditer(captured)]
        if not any(item.get("commandId") == "view.scroll-down" and item.get("scrollTop") == 2 for item in commands):
            raise SystemExit(f"configured scroll-lines did not move by two rows: {commands!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config scroll-lines PTY passed: editor.scroll-lines=2 moved the launched view command by two rows.")
