#!/usr/bin/env python3
"""Exercise Outline through the production launcher and an actual TS language server."""
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
STATE = re.compile(rb"XI_OUTLINE_STATE (\{[^\r\n]*\})")


def read_until(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
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


with tempfile.TemporaryDirectory(prefix="xi-t050-outline-") as temporary:
    workspace = Path(temporary)
    (workspace / "package.json").write_text("{}\n", encoding="utf-8")
    (workspace / "main.ts").write_text("function render(value: number): number { return value + 1; }\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"],
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
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b" vo")
        read_until(master, captured, b"XI_OUTLINE_OPEN", 5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            if any(state.get("state") == "ready" and state.get("symbols", 0) >= 1 for state in states):
                break
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        else:
            raise SystemExit(f"Outline never reached ready state: {states!r}")
        os.write(master, b"\x1b")
        read_until(master, captured, b"XI_OUTLINE_CLOSED", 5)
        os.write(master, b"llllllll k")
        read_until(master, captured, b"XI_HOVER_OPEN", 5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            hover_states = [json.loads(match.group(1)) for match in re.finditer(rb"XI_HOVER_STATE (\{[^\r\n]*\})", captured)]
            if any(state.get("state") == "ready" and state.get("hasText") is True for state in hover_states):
                break
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        else:
            raise SystemExit(f"Hover never reached ready state: {hover_states!r}")
        os.write(master, b"\x1b")
        read_until(master, captured, b"XI_HOVER_CLOSED", 5)
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production Outline exited {child.returncode}")

print("T050 production PTY passed live TS language-server Outline load, ready state, close and focus return")
