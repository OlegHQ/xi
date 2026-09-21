#!/usr/bin/env python3
"""Prove editor.buffer-picker.start-position selects the tracked alternate buffer."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PICKER = re.compile(rb"XI_BUFFER_PICKER (\{[^\r\n]*\})")

with tempfile.TemporaryDirectory(prefix="xi-buffer-picker-pty-") as temporary:
    root = Path(temporary)
    alpha = root / "alpha.txt"
    beta = root / "beta.txt"
    alpha.write_text("alpha\n", encoding="utf-8")
    beta.write_text("beta\n", encoding="utf-8")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor.buffer-picker]\nstart-position = "previous"\n', encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "alpha.txt"],
        cwd=root,
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
            raise SystemExit(f"workbench did not start: {captured[-4000:]!r}")
        os.write(master, b":e beta.txt\r")
        time.sleep(0.5)
        os.write(master, b" b")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not PICKER.search(captured):
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        matches = [json.loads(match.group(1)) for match in PICKER.finditer(captured)]
        if not any(item.get("startPosition") == "previous" and item.get("selectedId") == "xi-launch-document" for item in matches):
            raise SystemExit(f"previous buffer was not selected: markers={matches!r}, output={captured[-5000:]!r}")
        os.write(master, b"\rAP\x1b\x13")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and alpha.read_text(encoding="utf-8") != "alphaP\n":
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        if alpha.read_text(encoding="utf-8") != "alphaP\n":
            raise SystemExit(f"selected previous buffer was not edited and saved: {alpha.read_bytes()!r}, output={captured[-5000:]!r}")
        os.write(master, b"\x1bq!")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")

print("Config buffer-picker.start-position PTY passed: previous selected the alternate buffer and the launched editor edited it.")
