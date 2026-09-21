#!/usr/bin/env python3
"""Exercise configured jump-label generation and selection through the launched Xi PTY."""
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
LABELS = re.compile(rb"XI_JUMP_LABELS (\{[^\r\n]*\})")
SELECTED = re.compile(rb"XI_JUMP_LABEL_SELECTED (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-t036-jump-label-pty-") as temporary:
    workspace = Path(temporary)
    (workspace / "main.txt").write_text("alpha beta\ngamma delta\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        'schema-version = 1\n[editor]\njump-label-alphabet = "xy"\n\n[keys.normal]\nw = "editor.goto-word"\n',
        encoding="utf-8",
    )
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
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
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-4000:]!r}")
        os.write(master, b"w")
        deadline = time.monotonic() + 8
        labels = None
        while labels is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
            match = LABELS.search(captured)
            if match is not None:
                labels = json.loads(match.group(1))
        if labels is None:
            raise SystemExit(f"jump labels were not opened\n{captured[-5000:]!r}")
        if labels.get("alphabet") != "xy" or labels.get("labels", [])[:4] != ["xx", "xy", "yx", "yy"]:
            raise SystemExit(f"configured jump-label alphabet was not applied: {labels!r}")
        os.write(master, b"xx")
        deadline = time.monotonic() + 8
        selected = None
        while selected is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
            match = SELECTED.search(captured)
            if match is not None:
                selected = json.loads(match.group(1))
        if selected != {"label": "xx", "line": 0, "utf16": 0, "moved": True}:
            raise SystemExit(f"jump label selection did not move the cursor: {selected!r}")
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}\n{captured[-8000:]!r}")

print("T036 production PTY passed editor.jump-label-alphabet generation and selection")
