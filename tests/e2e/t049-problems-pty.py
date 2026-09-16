#!/usr/bin/env python3
"""Exercise the production Problems panel route through a real terminal."""
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


with tempfile.TemporaryDirectory(prefix="xi-t049-problems-") as temporary:
    workspace = Path(temporary)
    (workspace / "sample.txt").write_text("sample\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "sample.txt"],
        cwd=workspace,
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
        os.write(master, b" d")
        wait_for(master, captured, b"XI_PROBLEMS_OPEN", 5)
        os.write(master, b"\x1b")
        wait_for(master, captured, b"XI_PROBLEMS_CLOSED", 5)
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production Problems panel exited {child.returncode}")

print("T049 production PTY passed Problems discovery, open, Esc close and quit")
