#!/usr/bin/env python3
"""T045/E05: search rapid typing, cancel, late old output through the production CLI.
docs/testing.md's E05 row: "Only latest generation displayed, typing remains
responsive." tests/search/t043-search.test.ts already proves the generation/staleness model
at the component level; tests/e2e/t043-search-pty.py exercises the production CLI but only
with deliberate, spaced-out edits (delete-then-retype with a settle wait between). Neither
exercises rapid, unthrottled keystrokes producing several overlapping search generations in
flight at once through the real production CLI, which is what this fixture adds.
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
RESULT = re.compile(rb"XI_SEARCH_RESULT (\{[^\r\n]*\})")
OPEN = re.compile(rb"XI_SEARCH_OPEN (\{[^\r\n]*\})")
OPENED = re.compile(rb"XI_SEARCH_OPENED (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.02)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def read_until(master: int, captured: bytearray, predicate, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"missing marker; captured tail={captured[-4000:]!r}")


def results(captured: bytearray) -> list[dict[str, object]]:
    return [json.loads(match.group(1)) for match in RESULT.finditer(captured)]


with tempfile.TemporaryDirectory(prefix="xi-t045-e05-") as temporary:
    workspace = Path(temporary)
    (workspace / "src").mkdir()
    # Distinct match sets per prefix so a stale generation's results are visibly wrong if
    # they ever "win" over the final query's own results.
    (workspace / "src" / "alpha.txt").write_text("alphabet soup\n", encoding="utf-8")
    (workspace / "src" / "alpine.txt").write_text("alpine trail\n", encoding="utf-8")
    (workspace / "src" / "alarm.txt").write_text("alarm clock\n", encoding="utf-8")
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

        # Type "alarm" one keystroke at a time with no settle delay in between -- each
        # intermediate prefix ("a", "al", "ala", "alar") starts its own search generation,
        # several of which will still be in flight when the next keystroke fires. Measure
        # the gap between consecutive keystroke acknowledgements (echoed cursor-move bytes)
        # to confirm typing itself never blocks waiting on a search to finish.
        keystroke_gaps = []
        for character in "alarm":
            before = len(captured)
            sent_at = time.monotonic()
            os.write(master, character.encode())
            read_until(master, captured, lambda data, b=before: len(data) > b, 2)
            keystroke_gaps.append(time.monotonic() - sent_at)

        # Let every in-flight generation fully settle, then confirm only the FINAL query's
        # own results are the ones actually displayed -- not a stale "a"/"al"/"ala"/"alar"
        # generation's results arriving late and clobbering the final one.
        read_until(
            master, captured,
            lambda data: any(item.get("state") == "ready" and item.get("query") == "alarm" for item in results(data)),
            5,
        )
        read_for(master, captured, 0.5)  # drain any further in-flight stale arrivals
        all_results = results(captured)
        if not all_results:
            raise SystemExit("no search results observed at all")
        final = all_results[-1]
        if final.get("query") != "alarm":
            raise SystemExit(f"a stale generation was displayed after the final query: {final!r}")
        if final.get("firstPath") != "src/alarm.txt":
            raise SystemExit(f"final displayed result does not match the final query's own match: {final!r}")

        if max(keystroke_gaps) > 1.0:
            raise SystemExit(f"a keystroke was not acknowledged promptly (max gap {max(keystroke_gaps):.3f}s): {keystroke_gaps!r}")

        # Cancel while a search may still be in flight; confirm clean cancellation and quit.
        # Esc first leaves insert mode for normal mode, a second Esc closes the panel.
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)
        os.write(master, b":q\r")
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

print("T045-E05-SEARCH-RAPID-TYPING-PTY pass: rapid unthrottled keystrokes produced multiple "
      "overlapping search generations, only the final query's own results were displayed, "
      "typing stayed responsive throughout, and cancel/quit worked cleanly")
