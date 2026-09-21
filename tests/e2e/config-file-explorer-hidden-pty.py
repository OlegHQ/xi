#!/usr/bin/env python3
"""Prove editor.file-explorer.hidden controls the launched Explorer policy."""
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
REFRESH = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")

with tempfile.TemporaryDirectory(prefix="xi-file-explorer-hidden-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor.file-explorer]\nhidden = true\n", encoding="utf-8")
    (root / "visible.txt").write_text("visible\n", encoding="utf-8")
    (root / ".secret.txt").write_text("hidden\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "visible.txt"],
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
        os.write(master, b" vf")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("state") == "ready" for item in matches):
                break
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
        if not any(item.get("state") == "ready" and item.get("includeHidden") is False for item in matches):
            raise SystemExit(f"file-explorer.hidden=true did not hide hidden entries: {matches!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-explorer.hidden PTY passed: hidden=true hid hidden entries in the launched Explorer.")
