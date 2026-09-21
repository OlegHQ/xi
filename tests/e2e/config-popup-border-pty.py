#!/usr/bin/env python3
"""Prove editor.popup-border reaches the launched file-picker surface."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-popup-border-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\npopup-border = "menu"\n', encoding="utf-8")
    source = root / "main.txt"
    source.write_text("main\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
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
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start: {captured[-3000:]!r}")
        os.write(master, b" f")
        deadline = time.monotonic() + 8
        while b"Files  >" not in captured and time.monotonic() < deadline:
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        if b"Files  >" not in captured:
            raise SystemExit(f"file picker did not open: {captured[-4000:]!r}")
        if "╭".encode() not in captured or "╮".encode() not in captured:
            raise SystemExit(f"menu popup border was not rendered: {captured[-4000:]!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config popup-border PTY passed: menu policy rendered a bordered production picker.")
