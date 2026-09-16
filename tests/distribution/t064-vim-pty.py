#!/usr/bin/env python3
"""Exercise common Vim operator and register paths through the launchable shell."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import shutil
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUN = shutil.which("bun")
if BUN is None:
    raise SystemExit("bun is required for the source PTY fixture")

with tempfile.TemporaryDirectory(prefix="xi-t064-vim-") as temporary:
    path = Path(temporary) / "sample.txt"
    path.write_text("hello world\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1", "HOME": temporary, "PATH": temporary})
    child = subprocess.Popen(
        [BUN, "run", "apps/xi/src/main.ts", str(path)], cwd=ROOT,
        env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and b"XI_WORKBENCH_READY" not in captured:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit("T064 Vim PTY did not become ready")
        for key in (b"d", b"w", b":", b"w", b"q", b"\r"):
            os.write(master, key)
            time.sleep(0.08)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"T064 Vim PTY exited {child.returncode}")
    if path.read_text(encoding="utf-8") != "world\n":
        raise SystemExit("T064 Vim PTY did not persist dw through :wq")
print("T064 Vim PTY passed dw, native Ex :wq and terminal shutdown through the production shell")
