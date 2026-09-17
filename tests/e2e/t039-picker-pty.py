#!/usr/bin/env python3
"""Exercise the production file picker, preview and cancel path through a PTY."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return
    if marker not in captured:
        raise SystemExit(f"missing PTY marker: {marker!r}")


with tempfile.TemporaryDirectory(prefix="xi-t039-picker-") as temporary:
    path = ROOT / "README.md"
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(path)],
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
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b" f")
        wait_for(master, captured, b"Files  >", 5)
        time.sleep(0.25)
        # Query a file distinct from the one already open (README.md itself), so this
        # exercises a real, still-discardable preview rather than the picker's dedup path
        # (navigating back onto an already-open file correctly reuses it without a preview
        # to cancel -- see docs/evidence/T045.md's E02 addendum).
        os.write(master, b"AGENTS.md")
        wait_for(master, captured, b"XI_PICKER_PREVIEW", 5)
        os.write(master, b"\x1b")
        wait_for(master, captured, b"XI_PICKER_CANCELLED", 5)
        if b'"activeViewId":"xi-launch-view"' not in captured:
            raise SystemExit("picker cancel did not restore the original view")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production picker exited {child.returncode}")

print("T039 production PTY passed file picker query, preview, cancel restoration and quit")
