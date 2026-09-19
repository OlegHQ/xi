#!/usr/bin/env python3
"""Exercise the launched CLI's workspace replacement path."""
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
RESULT = re.compile(rb"XI_SEARCH_RESULT (\{[^\r\n]*\})")


def read_until(master: int, captured: bytearray, predicate, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return
    raise SystemExit(f"missing replacement marker; captured={captured[-4000:]!r}")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return


def search_results(captured: bytearray) -> list[dict[str, object]]:
    return [json.loads(match.group(1)) for match in RESULT.finditer(captured)]


with tempfile.TemporaryDirectory(prefix="xi-t044-replace-") as temporary:
    workspace = Path(temporary)
    target = workspace / "target.txt"
    target.write_text("needle one\nneedle two\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts")],
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
        read_until(master, captured, lambda data: b"XI_WORKBENCH_READY" in data, 10)
        os.write(master, b" /")
        read_until(master, captured, lambda data: b"XI_SEARCH_OPEN" in data, 5)
        os.write(master, b"needle")
        read_until(master, captured, lambda data: any(item.get("state") == "ready" and item.get("totalMatches") == 2 for item in search_results(data)), 5)
        # Esc first leaves insert mode for normal mode, a second Esc closes the panel.
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)
        second_result_count = len(search_results(captured))
        os.write(master, b" r")
        read_until(master, captured, lambda data: data.count(b"XI_SEARCH_OPEN") >= 2, 5)
        read_until(master, captured, lambda data: any(item.get("state") == "ready" and item.get("totalMatches") == 2 for item in search_results(data)[second_result_count:]), 5)
        # The ready marker precedes the full-height result frame. Drain that frame before
        # sending replacement input so a small PTY output buffer cannot stall the child.
        read_for(master, captured, 0.2)
        os.write(master, b"done\r")
        read_until(master, captured, lambda data: b"XI_REPLACE_APPLIED" in data, 5)
        if target.read_text(encoding="utf-8") != "done one\ndone two\n":
            raise SystemExit(f"replacement bytes mismatch: {target.read_bytes()!r}")
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: data.count(b"XI_SEARCH_CANCELLED") >= 2, 5)
        os.write(master, b":q\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"replacement exited {child.returncode}")

print("T044 production PTY passed search preview, workspace apply and exact saved bytes")
