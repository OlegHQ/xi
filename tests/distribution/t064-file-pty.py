#!/usr/bin/env python3
"""Exercise the packaged-style CLI file[:line] launch through a real PTY."""
from __future__ import annotations
import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

path = Path(tempfile.gettempdir()) / "xi-t064-file-20260915.txt"
path.write_text("first line\nsecond 😀 line\n", encoding="utf-8")
master, slave = pty.openpty()
environment = os.environ.copy()
environment["TERM"] = "xterm-256color"
environment["XI_UI_TEST_MARKERS"] = "1"
child = subprocess.Popen(
    ["bun", "run", "apps/xi/src/main.ts", f"{path}:2"],
    cwd=Path(__file__).resolve().parents[2],
    env=environment,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
transcript = bytearray()
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.25)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            transcript.extend(chunk)
        if b"XI_WORKBENCH_READY" in transcript:
            break
    os.write(master, b"q")
    child.wait(timeout=5)
finally:
    os.close(master)
text = transcript.decode("utf-8", errors="replace")
if child.returncode != 0 or b"XI_WORKBENCH_READY" not in transcript:
    raise SystemExit(f"T064 file PTY failed: exit={child.returncode} bytes={len(transcript)}")
if path.name.encode() not in transcript or not (b"second" in transcript or b"econd" in transcript):
    raise SystemExit("T064 file PTY did not render the requested file")
print(f"T064 file PTY passed file:line launch, label and Unicode content; exit={child.returncode}, bytes={len(text.encode())}")
