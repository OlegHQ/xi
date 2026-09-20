#!/usr/bin/env python3
"""T045/E06: replace selected matches across a dirty (open, unsaved) buffer and a closed
(disk-only) file in the same operation, through the production CLI.
docs/testing.md's E06 row: "Replace selected matches in dirty and closed files" ->
"Preview matches applied bytes, stale file blocked, partial failure explained."
tests/e2e/t044-replace-pty.py already covers the closed-file half (a file never opened as a
buffer, replaced directly on disk); this fixture adds the dirty-buffer half in the same
workspace-wide operation, confirming the replacement commits through the open document (not a
direct disk write) so it composes correctly with the buffer's own separate unsaved edit, and
that the closed file is still written straight to disk.
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


def read_until(master: int, captured: bytearray, predicate, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"missing marker/condition; captured tail={captured[-4000:]!r}")


def search_results(captured: bytearray) -> list[dict]:
    return [json.loads(m.group(1)) for m in RESULT.finditer(captured)]


with tempfile.TemporaryDirectory(prefix="xi-t045-e06-") as temporary:
    workspace = Path(temporary)
    alpha = workspace / "alpha.txt"
    beta = workspace / "beta.txt"
    alpha.write_text("needle in alpha\n", encoding="utf-8")
    beta.write_text("needle in beta\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "alpha.txt"],
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

        # Dirty alpha.txt's open buffer with an unrelated edit, unsaved.
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        os.write(master, b" UNRELATED")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # Search "needle" across the workspace -- one match in the dirty alpha.txt buffer,
        # one in the closed, disk-only beta.txt.
        os.write(master, b" /")
        read_until(master, captured, lambda data: b"XI_SEARCH_OPEN" in data, 5)
        os.write(master, b"needle")
        read_until(master, captured, lambda data: any(item.get("state") == "ready" and item.get("totalMatches") == 2 for item in search_results(data)), 5)
        # Esc first leaves insert mode for normal mode, a second Esc closes the panel.
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        read_until(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)

        # Leader keys (including the space that starts them) only reach the leader dispatcher
        # while no panel's own keypress handler has focus -- reopening search fresh (mirroring
        # tests/e2e/t044-replace-pty.py's own proven pattern) is required before " r" can enter
        # replace mode; the query persists across the close/reopen.
        second_result_count = len(search_results(captured))
        os.write(master, b" r")
        read_until(master, captured, lambda data: data.count(b"XI_SEARCH_OPEN") >= 2, 5)
        read_until(master, captured, lambda data: any(item.get("state") == "ready" and item.get("totalMatches") == 2 for item in search_results(data)[second_result_count:]), 5)
        os.write(master, b"done\r")
        read_until(master, captured, lambda data: b"XI_REPLACE_APPLIED" in data, 5)
        applied = json.loads(re.search(rb"XI_REPLACE_APPLIED (\{[^\r\n]*\})", captured).group(1))
        if applied.get("files") != 2:
            raise SystemExit(f"replace did not report both files applied: {applied!r}")

        # alpha.txt is dirty (open buffer): the replacement must have committed through the
        # document, not written straight to disk -- disk must still show its original,
        # entirely pre-edit content (neither the unrelated edit nor the replacement) until an
        # explicit save.
        alpha_before_save = alpha.read_text(encoding="utf-8")
        if alpha_before_save != "needle in alpha\n":
            raise SystemExit(f"alpha.txt (a dirty buffer) was written to disk before any save: {alpha_before_save!r}")

        # beta.txt is closed (disk-only): the replacement must have been written straight to
        # disk immediately, with no buffer/save step required.
        beta_after_replace = beta.read_text(encoding="utf-8")
        if beta_after_replace != "done in beta\n":
            raise SystemExit(f"beta.txt (a closed file) was not replaced directly on disk: {beta_after_replace!r}")

        # Now save everything: alpha.txt's buffer must contain BOTH the unrelated edit and the
        # in-memory replacement, composed correctly, once written.
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)
        os.write(master, b":wa\r")
        read_for(master, captured, 0.5)
        os.write(master, b":qa!\r")
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
    alpha_final = alpha.read_text(encoding="utf-8")

expected = "done in alpha UNRELATED\n"
if alpha_final != expected:
    raise SystemExit(f"the dirty buffer's replacement and its separate unsaved edit did not both survive the save: expected {expected!r}, got {alpha_final!r}")
print("T045-E06-REPLACE-DIRTY-CLOSED-PTY pass: a workspace-wide replace across one dirty open "
      "buffer and one closed disk-only file applied correctly to both -- the dirty buffer's "
      "replacement committed through the document (composing with its own separate unsaved "
      "edit) rather than writing straight to disk, while the closed file was written directly")
