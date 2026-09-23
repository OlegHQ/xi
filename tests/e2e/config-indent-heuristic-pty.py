#!/usr/bin/env python3
"""Prove editor.indent-heuristic reaches the launched Vim insertion path."""
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
POLICY = re.compile(rb"XI_INDENT_HEURISTIC (\{[^\r\n]*\})")

with tempfile.TemporaryDirectory(prefix="xi-indent-heuristic-pty-") as temporary:
    root = Path(temporary)
    source = root / "main.txt"
    source.write_bytes(b"  one")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nindent-heuristic = "hybrid"\ninsert-final-newline = false\n', encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
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
        before_insert = len(captured)
        os.write(master, b"oX")
        deadline = time.monotonic() + 5
        while b"INS" not in captured[before_insert:] and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        if b"INS" not in captured[before_insert:]:
            raise SystemExit("opening a new indented line did not enter Insert mode")
        before_escape = len(captured)
        os.write(master, b"\x1b")
        deadline = time.monotonic() + 5
        while b"NOR" not in captured[before_escape:] and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        if b"NOR" not in captured[before_escape:]:
            raise SystemExit("Escape did not return to Normal mode")
        os.write(master, b"\x13")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and (source.read_bytes() != b"  one\n  X" or not POLICY.search(captured)):
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        policies = [json.loads(match.group(1)) for match in POLICY.finditer(captured)]
        if source.read_bytes() != b"  one\n  X" or not any(policy.get("configured") == "hybrid" and policy.get("applied") == "simple" for policy in policies):
            raise SystemExit(f"indent-heuristic was not applied: bytes={source.read_bytes()!r}, policies={policies!r}, output={captured[-4000:]!r}")
        os.write(master, b":qa!\r")
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
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config indent-heuristic PTY passed: hybrid used the documented simple indentation fallback in the launched editor.")
