#!/usr/bin/env python3
"""Prove editor.search.smart-case reaches the launched workspace search."""
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


def read_until(master: int, captured: bytearray, predicate, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        if select.select([master], [], [], 0.05)[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return
    raise SystemExit(f"missing search marker: {captured[-4000:]!r}")


def results(captured: bytearray) -> list[dict[str, object]]:
    return [json.loads(match.group(1)) for match in RESULT.finditer(captured)]


with tempfile.TemporaryDirectory(prefix="xi-search-smart-case-pty-") as temporary:
    workspace = Path(temporary)
    (workspace / ".config" / "xi").mkdir(parents=True)
    (workspace / ".config" / "xi" / "config.toml").write_text(
        "schema-version = 1\n[editor.search]\nsmart-case = true\nwrap-around = true\n",
        encoding="utf-8",
    )
    (workspace / "Upper.txt").write_text("Needle\n", encoding="utf-8")
    (workspace / "lower.txt").write_text("needle\n", encoding="utf-8")
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
        os.write(master, b"Needle")
        read_until(master, captured, lambda data: any(
            item.get("state") == "ready" and item.get("query") == "Needle" for item in results(data)
        ), 5)
        final = [item for item in results(captured) if item.get("query") == "Needle"][-1]
        if final.get("totalMatches") != 1 or final.get("firstPath") != "Upper.txt":
            raise SystemExit(f"smart-case did not filter lowercase matches: {final!r}")
        # Lowercase search is case-insensitive, so both files match.  After two downward
        # moves, wrap-around must select Upper.txt again; Enter exposes that selection on
        # the production open marker.
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)
        os.write(master, b" /")
        read_until(master, captured, lambda data: len(OPEN.findall(data)) >= 2, 5)
        os.write(master, b"\x7f" * len("Needle") + b"needle")
        read_until(master, captured, lambda data: any(
            item.get("state") == "ready" and item.get("query") == "needle" and item.get("totalMatches") == 2
            for item in results(data)
        ), 5)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"jj\r")
        read_until(master, captured, lambda data: b'XI_SEARCH_OPENED {"path":"Upper.txt"' in data, 5)
        os.write(master, b":qa\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            raise SystemExit(f"search did not exit after cancel: {captured[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config search smart-case PTY passed: uppercase queries matched only case-sensitive workspace results.")
