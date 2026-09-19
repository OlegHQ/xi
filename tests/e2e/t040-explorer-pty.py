#!/usr/bin/env python3
"""Exercise the launched Explorer with real filesystem insert/rename events."""
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
MARKER = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
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


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return


def refreshes(captured: bytearray) -> list[dict[str, object]]:
    return [json.loads(match.group(1)) for match in MARKER.finditer(captured)]


def wait_for_refresh(master: int, captured: bytearray, predicate, timeout: float, minimum_count: int = 0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = refreshes(captured)
        if len(current) > minimum_count and current[-1] is not None and predicate(current[-1]):
            return
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return
    raise SystemExit(f"missing Explorer refresh state; got {refreshes(captured)!r}")


with tempfile.TemporaryDirectory(prefix="xi-t040-explorer-") as temporary:
    workspace = Path(temporary)
    (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
    (workspace / "other.txt").write_text("other\n", encoding="utf-8")
    (workspace / "src").mkdir()
    (workspace / "src" / "nested.txt").write_text("nested\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "seed.txt"],
        cwd=temporary,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b" vf")
        wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
        wait_for_refresh(master, captured, lambda item: item.get("state") == "ready", 5)
        os.write(master, b"jjj")
        wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "seed.txt", 5)
        before_insert = refreshes(captured)
        selected_before = next((item for item in reversed(before_insert) if item.get("selectedPath") == "seed.txt"), None)
        if selected_before is None:
            raise SystemExit(f"Explorer did not select seed.txt through panel navigation: {before_insert!r}")

        refresh_count = len(before_insert)
        (workspace / "aaa.txt").write_text("inserted\n", encoding="utf-8")
        wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "seed.txt" and item.get("state") == "ready", 5, refresh_count)
        after_insert = refreshes(captured)
        selected_after_insert = next((item for item in reversed(after_insert) if item.get("selectedPath") == "seed.txt"), None)
        if selected_after_insert is None or selected_after_insert.get("selectedId") != selected_before.get("selectedId"):
            raise SystemExit("external insertion changed Explorer selection identity")

        # Let the first watcher callback and its async reconciliation unwind
        # before delivering the independent rename event from the test host.
        time.sleep(0.1)
        refresh_count = len(after_insert)
        (workspace / "seed.txt").rename(workspace / "renamed.txt")
        wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "renamed.txt" and item.get("state") == "ready", 5, refresh_count)
        after_rename = refreshes(captured)
        selected_after_rename = next((item for item in reversed(after_rename) if item.get("selectedPath") == "renamed.txt"), None)
        if selected_after_rename is None or selected_after_rename.get("selectedId") != selected_before.get("selectedId"):
            raise SystemExit("external rename did not preserve Explorer selection identity")

        # `l` previews the selected file in the editor without handing keyboard focus to it:
        # the following `j` must still navigate the tree.
        os.write(master, b"k")
        wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "other.txt", 5, len(after_rename))
        before_preview = len(refreshes(captured))
        os.write(master, b"l")
        wait_for(master, captured, b'XI_EXPLORER_PREVIEW {"path":"other.txt"}', 5)
        os.write(master, b"j")
        wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "renamed.txt", 5, before_preview)

        os.write(master, b"\x1b")
        # Closing a full-height panel repaints the cells it uncovered. Keep draining the PTY
        # while that frame is written so the child cannot block on terminal backpressure
        # before it receives the following quit key.
        read_for(master, captured, 0.15)
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production Explorer exited {child.returncode}")

print("T040 production PTY passed Explorer focus, non-focusing l preview, external insertion and stable rename selection")
