#!/usr/bin/env python3
"""Disabling picker ignore sources exposes ordinary ignored directories."""
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

with tempfile.TemporaryDirectory(prefix="xi-picker-visible-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[editor.file-picker]\nparents = false\nignore = false\ngit-ignore = false\ngit-global = false\ngit-exclude = false\n",
        encoding="utf-8",
    )
    (root / ".git").mkdir()
    (root / ".gitignore").write_text("dist/\n", encoding="utf-8")
    (root / "dist").mkdir()
    (root / "dist" / "a.txt").write_text("listed\n", encoding="utf-8")
    source = root / "visible.txt"
    source.write_text("visible\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start: {captured[-2000:]!r}")
        os.write(master, b" f")
        time.sleep(0.2)
        os.write(master, b"a.txt")
        deadline = time.monotonic() + 5
        while not re.search(rb"XI_PICKER_PREVIEW \{[^\r\n]*/dist/a\.txt", captured) and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        if not re.search(rb"XI_PICKER_PREVIEW \{[^\r\n]*/dist/a\.txt", captured):
            raise SystemExit(f"disabled ignore flags did not expose dist/a.txt: {captured[-3000:]!r}")
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}")

print("File-picker production PTY passed: disabled ignore sources expose dist/a.txt")
