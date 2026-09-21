#!/usr/bin/env python3
"""Exercise the launcher's first document editing loop through a real PTY."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from terminal_screen import Screen  # noqa: E402

temporary = tempfile.TemporaryDirectory(prefix="xi-t064-editor-loop-")
path = Path(temporary.name) / "editor.txt"
path.write_text("hello\n", encoding="utf-8")
master, slave = pty.openpty()
environment = os.environ.copy()
environment["TERM"] = "xterm-256color"
environment["XI_UI_TEST_MARKERS"] = "1"
environment["HOME"] = temporary.name
child = subprocess.Popen(
    ["bun", "run", str(Path(__file__).resolve().parents[2] / "apps/xi/src/main.ts"), str(path)],
    cwd=temporary.name,
    env=environment,
    stdin=slave,
    stdout=slave,
    stderr=subprocess.PIPE,
    close_fds=True,
)
os.close(slave)
transcript = bytearray()
diagnostics = bytearray()
screen = Screen(24, 80)
assert child.stderr is not None

def read_for(seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master, child.stderr.fileno()], [], [], 0.05)
        if not readable:
            continue
        for descriptor in readable:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError:
                return
            if not chunk:
                continue
            if descriptor == master:
                transcript.extend(chunk)
                screen.feed(chunk)
            else:
                diagnostics.extend(chunk)

try:
    read_for(8)
    if b"XI_WORKBENCH_READY" not in diagnostics:
        raise SystemExit("T064 editor PTY did not reach the workbench")
    for key in (b"i", b"X"):
        os.write(master, key)
        read_for(0.35)
    if "INS" not in screen.row_text(24) or "Xhello" not in screen.row_text(1):
        raise SystemExit(f"T064 editor PTY did not render insert mode and inserted text: row={screen.row_text(1)!r} status={screen.row_text(24)!r}")
    os.write(master, b"\x1b")
    read_for(0.35)
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
temporary.cleanup()
