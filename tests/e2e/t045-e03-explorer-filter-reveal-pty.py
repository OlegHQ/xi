#!/usr/bin/env python3
"""T045/E03: Explorer expand/filter/reveal through the production CLI.
docs/testing.md's E03 row: "Tree expand/filter/reveal and watcher insertion" ->
"Stable selected path, no unsolicited focus/scroll." tests/e2e/t040-explorer-pty.py already
exercises real-watcher insertion/rename with stable selection identity through the launched
Explorer panel -- but not reveal-on-open, filter narrowing/restore, or "no unsolicited focus"
while Explorer is closed and a watcher event fires in the background. This fixture covers
those three remaining pieces.

1. Opening a file nested inside a subdirectory, then opening the Explorer, must auto-reveal
   and select that file (expanding its parent directory) with no manual navigation at all.
2. Typing a filter query must narrow the visible rows to only matches (and their ancestors);
   clearing the filter must restore the full row count.
3. With the Explorer closed, an external filesystem insertion (the same real watcher event
   t040 exercises) must not steal keyboard focus back to the editor's own already-focused
   session -- confirmed by typing immediately afterward and finding the keystrokes landed in
   the document, not swallowed or misrouted.
"""
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


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


def refreshes(captured: bytearray) -> list[dict]:
    return [json.loads(m.group(1)) for m in REFRESH.finditer(captured)]


def wait_for_refresh(master: int, captured: bytearray, predicate, timeout: float, minimum_count: int = 0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = refreshes(captured)
        matches = [item for item in current[minimum_count:] if predicate(item)]
        if matches:
            return matches[-1]
        read_for(master, captured, 0.05)
    raise SystemExit(f"no matching Explorer refresh (after index {minimum_count}); got {refreshes(captured)!r}")


with tempfile.TemporaryDirectory(prefix="xi-t045-e03-") as temporary:
    workspace = Path(temporary)
    (workspace / "src").mkdir()
    (workspace / "src" / "nested.txt").write_text("nested\n", encoding="utf-8")
    (workspace / "other.txt").write_text("other\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "src/nested.txt"],
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

        # 1. Opening the Explorer must auto-reveal the already-open nested file, expanding
        # its parent directory, with no manual navigation at all.
        os.write(master, b" vf")
        wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
        revealed = wait_for_refresh(master, captured, lambda item: item.get("selectedPath") == "src/nested.txt", 5)
        full_row_count = revealed["visibleRowCount"]
        if not isinstance(full_row_count, int) or full_row_count < 2:
            raise SystemExit(f"reveal did not expand the parent directory into view: {revealed!r}")

        # 2. Filtering must narrow the visible rows; clearing it must restore the full count.
        after_reveal_count = len(refreshes(captured))
        os.write(master, b"/other")
        filtered = wait_for_refresh(master, captured, lambda item: item.get("filter") == "other", 5, after_reveal_count)
        if not isinstance(filtered.get("visibleRowCount"), int) or filtered["visibleRowCount"] >= full_row_count:
            raise SystemExit(f"filtering 'other' did not narrow the visible rows: {filtered!r} (full was {full_row_count})")
        after_filter_count = len(refreshes(captured))
        os.write(master, b"\x1b")
        cleared = wait_for_refresh(master, captured, lambda item: item.get("filter") == "" and item.get("visibleRowCount") == full_row_count, 5, after_filter_count)
        if cleared is None:
            raise SystemExit("clearing the filter did not restore the full row count")

        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)

        # 3. With the Explorer closed, an external insertion must not steal focus back to the
        # editor -- typing immediately afterward must land in the document, not be swallowed.
        # (The Explorer refresh marker itself is gated on explorerOpen, so a closed Explorer
        # emits no XI_EXPLORER_REFRESH at all for this insertion -- confirmed below.)
        before_insert_count = len(refreshes(captured))
        (workspace / "zzz-inserted.txt").write_text("inserted\n", encoding="utf-8")
        read_for(master, captured, 0.4)
        if len(refreshes(captured)) > before_insert_count:
            raise SystemExit("the Explorer was still open (or reopened) after the second Escape")
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b"FOCUSED")
        read_for(master, captured, 0.3)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":wq\r")
        for _ in range(5):
            if child.poll() is not None:
                break
            read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    final_text = (workspace / "src" / "nested.txt").read_text(encoding="utf-8")

expected = "nestedFOCUSED\n"
if final_text != expected:
    raise SystemExit(f"an external Explorer-watcher insertion stole keyboard focus from the editor: expected {expected!r}, got {final_text!r}")
print("T045-E03-EXPLORER-FILTER-REVEAL-PTY pass: opening the Explorer auto-revealed a nested "
      "already-open file, filtering narrowed and restored the visible rows correctly, and an "
      "external filesystem insertion with the Explorer closed never stole keyboard focus back "
      "from the editor")
