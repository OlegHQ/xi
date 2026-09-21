#!/usr/bin/env python3
"""Prove editor.rainbow-brackets changes the launched syntax paint scopes."""
from __future__ import annotations

import json
import fcntl
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
STATE = re.compile(rb"XI_SYNTAX_STATE (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def launch(root: Path, enabled: bool) -> tuple[subprocess.Popen[bytes], int, bytearray]:
    config = root / f"rainbow-{enabled}.toml"
    config.write_text(f"schema-version = 1\n[editor]\nrainbow-brackets = {'true' if enabled else 'false'}\n", encoding="utf-8")
    source = root / "rainbow.ts"
    source.write_text("function f(a) { return [a, {x: (a)}]; }\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": str(root), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "--config", str(config), str(source)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    return child, master, bytearray()


with tempfile.TemporaryDirectory(prefix="xi-rainbow-brackets-pty-") as temporary:
    root = Path(temporary)
    for enabled in (False, True):
        child, master, captured = launch(root, enabled)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                read_for(master, captured, 0.05)
                states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
                if states and (not enabled or states[-1].get("rainbowScopes")):
                    break
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            if not states:
                raise SystemExit(f"Xi emitted no syntax state for rainbow={enabled}: {captured[-5000:]!r}")
            scopes = states[-1].get("rainbowScopes", [])
            if bool(scopes) != enabled:
                raise SystemExit(f"rainbow={enabled} produced unexpected scopes {scopes!r}: {captured[-5000:]!r}")
            os.write(master, b"q")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi rainbow={enabled} exited {child.returncode}: {captured[-5000:]!r}")

print("T036 production PTY passed: editor.rainbow-brackets controls launched syntax scopes.")
