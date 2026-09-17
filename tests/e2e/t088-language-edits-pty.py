#!/usr/bin/env python3
"""Exercise multi-cursor completion through the production CLI and PTY."""
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
APPLIED = re.compile(rb"XI_COMPLETION_APPLIED (\{[^\r\n]*\})")
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
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-3000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t088-language-") as temporary:
    workspace = Path(temporary)
    (workspace / "package.json").write_text("{}\n", encoding="utf-8")
    source = workspace / "main.ts"
    source.write_text("Math.\nMath.\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
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
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        for command in (b":Xi selection.select-all-matches Math\r", b":Xi selection.collapse\r"):
            os.write(master, command)
            time.sleep(0.2)
            captured.extend(os.read(master, 65536) if select.select([master], [], [], 0.05)[0] else b"")
        os.write(master, b"a\x00")
        read_until(master, captured, b"XI_COMPLETION_OPEN", 5)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if any(json.loads(match.group(1)).get("state") == "ready" and json.loads(match.group(1)).get("items", 0) > 0 for match in STATE.finditer(captured)):
                break
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        os.write(master, b"\x0e\t")
        read_until(master, captured, b"XI_COMPLETION_APPLIED", 5)
        applied = [json.loads(match.group(1)) for match in APPLIED.finditer(captured)]
        if not applied or applied[-1].get("members") != 2:
            raise SystemExit(f"completion did not apply to both carets: {applied!r}\n{captured[-5000:]!r}")
        os.write(master, b"\x1b")
        time.sleep(0.2)
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
        raise SystemExit(f"production multi-cursor completion exited {child.returncode}\n{captured[-5000:]!r}")
    artifact = ROOT / ".artifacts/e2e/t088-language-edits.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({"schema_version": 1, "fixture": "T088-MC11-production", "completion": applied}, indent=2) + "\n", encoding="utf-8")

print("T088 production PTY passed equivalent multi-cursor completion application")
