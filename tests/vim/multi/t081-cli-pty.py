#!/usr/bin/env python3
"""Drive the Xi selection extension through the production CLI in a PTY."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]

with tempfile.TemporaryDirectory(prefix="xi-t081-") as temporary:
    path = Path(temporary) / "selection.txt"
    path.write_text("one two one\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1", "HOME": temporary})
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
        read_for(10)
        if b"XI_WORKBENCH_READY" not in transcript:
            raise SystemExit("T081 CLI PTY did not reach the workbench")
        for key in (
            b":Xi selection.select-all-matches one\r",
            b":Xi selection.collapse\r",
            b"iX\x1b",
            b":wq\r",
        ):
            os.write(master, key)
            read_for(0.4)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

    if child.returncode != 0:
        raise SystemExit(f"T081 CLI PTY exited {child.returncode}")
    if path.read_text(encoding="utf-8") != "onXe two onXe\n":
        raise SystemExit("T081 CLI PTY did not apply the selection edit to both occurrences")

print("T081 CLI PTY passed Xi select-all, collapse, multi-cursor insert, save and quit")
