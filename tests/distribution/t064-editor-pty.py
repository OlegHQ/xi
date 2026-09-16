#!/usr/bin/env python3
"""Exercise the launcher's first document editing loop through a real PTY."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

path = Path(tempfile.gettempdir()) / "xi-t064-editor-loop.txt"
path.write_text("hello\n", encoding="utf-8")
master, slave = pty.openpty()
environment = os.environ.copy()
environment["TERM"] = "xterm-256color"
environment["XI_UI_TEST_MARKERS"] = "1"
child = subprocess.Popen(
    ["bun", "run", "apps/xi/src/main.ts", str(path)],
    cwd=Path(__file__).resolve().parents[2],
    env=environment,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
transcript = bytearray()

def read_for(seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        transcript.extend(chunk)

try:
    read_for(8)
    if b"XI_WORKBENCH_READY" not in transcript:
        raise SystemExit("T064 editor PTY did not reach the workbench")
    for key in (b"i", b"X", b"\x1b"):
        os.write(master, key)
        read_for(0.35)
    if b"INSERT" not in transcript or b"X" not in transcript:
        raise SystemExit("T064 editor PTY did not render insert mode and inserted text")
    os.write(master, b"\x13")  # Ctrl-S; the file path is writable.
    read_for(0.35)
    os.write(master, b"q")
    child.wait(timeout=5)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)

if child.returncode != 0:
    raise SystemExit(f"T064 editor PTY exited {child.returncode}")
if path.read_text(encoding="utf-8") != "Xhello\n":
    raise SystemExit("T064 editor PTY save did not persist the inserted text")
print("T064 editor PTY passed insertion, Escape, save and quit through the launchable shell")
