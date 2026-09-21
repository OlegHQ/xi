#!/usr/bin/env python3
"""Prove editor.lsp.enable=false disables language-server startup in launched Xi."""
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
DISABLED = re.compile(rb"XI_LANGUAGE_DISABLED (\{[^\r\n]*\})")
STARTED = re.compile(rb"XI_LANGUAGE_STARTED (\{[^\r\n]*\})")


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


with tempfile.TemporaryDirectory(prefix="xi-lsp-enable-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.lsp]\nenable = false\n", encoding="utf-8")
    source = root / "main.ts"
    source.write_text("const value: number = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    import fcntl
    import struct
    import termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / "config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", "apps/xi/src/main.ts", str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        read_for(master, captured, 1)
        disabled = [json.loads(match.group(1)) for match in DISABLED.finditer(captured)]
        started = [json.loads(match.group(1)) for match in STARTED.finditer(captured)]
        if not disabled or started:
            raise SystemExit(f"editor.lsp.enable=false did not gate startup: disabled={disabled!r} started={started!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config LSP enable PTY passed: editor.lsp.enable=false suppressed language-server startup.")
