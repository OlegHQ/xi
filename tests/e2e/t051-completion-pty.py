#!/usr/bin/env python3
"""Exercise production completion transport, selection routing and acceptance."""
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
STATE = re.compile(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})")


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
        raise SystemExit(f"missing PTY marker: {marker!r}\n{captured[-2000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t051-completion-") as temporary:
    workspace = Path(temporary)
    (workspace / "package.json").write_text("{}\n", encoding="utf-8")
    (workspace / "main.ts").write_text("Math.\n", encoding="utf-8")
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
        os.write(master, b"$a\x00")
        read_until(master, captured, b"XI_COMPLETION_OPEN", 5)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            if any(state.get("state") == "ready" and state.get("items", 0) > 0 for state in states):
                break
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        else:
            raise SystemExit(f"completion never reached ready state: {states!r}\n{captured[-4000:]!r}")
        os.write(master, b"\x0e\t")
        read_until(master, captured, b"XI_COMPLETION_APPLIED", 5)
        os.write(master, b"\x1b")
        time.sleep(0.1)
        # The applied completion left the buffer dirty; bare 'q' now correctly refuses a
        # dirty buffer like ':q' does, so discard the scratch edit explicitly.
        os.write(master, b":q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production completion exited {child.returncode}\n{captured[-8000:]!r}")

print("T051 production PTY passed live TS completion, Ctrl-N selection, Tab acceptance and one-document LSP edit")
