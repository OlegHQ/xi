#!/usr/bin/env python3
"""Prove editor.file-picker.hidden reaches the launched production picker."""
from __future__ import annotations

import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-file-picker-hidden-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.file-picker]\nhidden = false\n", encoding="utf-8")
    source = root / "visible.txt"
    source.write_text("visible\n", encoding="utf-8")
    (root / ".secret.txt").write_text("hidden\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", "apps/xi/src/main.ts", str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        os.write(master, b" f")
        read_for(master, captured, 1)
        if b"Files  >" not in captured:
            raise SystemExit(f"file picker did not open: {captured[-4000:]!r}")
        os.write(master, b".secret.txt")
        read_for(master, captured, 1)
        if re.search(rb"XI_PICKER_PREVIEW \{[^\r\n]*\.secret\.txt", captured):
            raise SystemExit("hidden file was previewed despite editor.file-picker.hidden=false")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-picker.hidden PTY passed: hidden entries stay out of the launched picker.")
