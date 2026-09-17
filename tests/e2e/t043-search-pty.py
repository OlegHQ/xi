#!/usr/bin/env python3
"""Exercise the production workspace search through the launched CLI."""
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
OPEN = re.compile(rb"XI_SEARCH_OPEN \{[^\r\n]*\}")
OPENED = re.compile(rb"XI_SEARCH_OPENED (\{[^\r\n]*\})")


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
    raise SystemExit(f"missing search marker; captured={captured[-4000:]!r}")


def results(captured: bytearray) -> list[dict[str, object]]:
    return [json.loads(match.group(1)) for match in RESULT.finditer(captured)]


with tempfile.TemporaryDirectory(prefix="xi-t043-search-") as temporary:
    workspace = Path(temporary)
    (workspace / "src").mkdir()
    (workspace / "src" / "target.txt").write_text("needle from disk\n", encoding="utf-8")
    (workspace / "src" / "other.txt").write_text("different\n", encoding="utf-8")
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
        read_until(master, captured, lambda data: OPEN.search(data) is not None, 5)
        os.write(master, b"needle")
        read_until(
            master,
            captured,
            lambda data: any(item.get("state") == "ready" and item.get("firstPath") == "src/target.txt" for item in results(data)),
            5,
        )
        os.write(master, b"\r")
        read_until(master, captured, lambda data: b'XI_SEARCH_OPENED {"path":"src/target.txt"' in data, 5)

        os.write(master, b" /")
        read_until(master, captured, lambda data: len(OPEN.findall(data)) >= 2, 5)
        second_result_count = len(results(captured))
        os.write(master, b"\x7f" * 6 + b"needle")
        read_until(
            master,
            captured,
            lambda data: any(item.get("query") == "needle" for item in results(data)[second_result_count:]),
            5,
        )
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: data.count(b"XI_SEARCH_CANCELLED") >= 2, 5)
        # The earlier Enter opened src/target.txt in its own split (real single-window `:q`
        # would only close that split); `:qa` closes every window and quits.
        os.write(master, b":qa\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            raise SystemExit(f"search did not exit after Ctrl-C; captured={captured[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production search exited {child.returncode}")

print("T043 production PTY passed workspace search, result open and cancellation")
