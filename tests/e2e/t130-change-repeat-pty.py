#!/usr/bin/env python3
"""T130 (extended): dot-repeat of an operator that transitions into insert -- 'ciw<text><Esc>'
and 'cc<text><Esc>' replayed as one atomic "delete then insert" unit, matching real Vim -- plus
regression coverage for the 'dd'/'cc' cursor-placement bug found and fixed while building this
(packages/vim/operators/core.ts's cursorAfterOperator returns a pre-edit-coordinate offset that
packages/workbench/vim-session/index.ts must map through the committed edits itself; it never
was, before this ticket).
"""
from __future__ import annotations

import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_until(master: int, captured: bytearray, marker: bytes, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        if not select.select([master], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            break
    return marker in captured


def send_key(master: int, captured: bytearray, key: bytes) -> None:
    os.write(master, key)
    # Let Xi consume this input and drain the rendered response before sending the next.
    deadline = time.monotonic() + 0.15
    quiet_since = time.monotonic()
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.01)
        if not readable:
            if time.monotonic() - quiet_since >= 0.015:
                return
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return
        quiet_since = time.monotonic()


def run(text: str, keys: list[bytes]) -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t130-change-") as temporary:
        source = Path(temporary) / "d.txt"
        source.write_text(text, encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
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
            if not read_until(master, captured, b"XI_WORKBENCH_READY", 10):
                raise RuntimeError(f"Xi did not become ready: {captured[-2000:]!r}")
            for key in keys:
                send_key(master, captured, key)
            os.write(master, b":wq\r")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        return source.read_text(encoding="utf-8")


cases: dict[str, tuple[str, list[bytes], str]] = {
    # The E01 scenario T045 names: ciw<text><Esc>, move, '.' redoes the delete AND the insert.
    "ciw combined change-repeat on the next line": (
        "hello world\nhello world\n", [b"gg0ciwgoodbye", b"\x1b", b"j0", b"."], "goodbye world\ngoodbye world\n",
    ),
    "cc combined change-repeat on the next line": (
        "one\ntwo\nthree\n", [b"ccXX", b"\x1b", b"j0", b"."], "XX\nXX\nthree\n",
    ),
    # dd/cc cursor-placement regression: deleting a line that is followed by more content.
    "dd cursor lands on the surviving line, not one past it": (
        "one\ntwo\nthree\nfour\n", [b"dd", b"x"], "wo\nthree\nfour\n",
    ),
    "dd dot-repeat now deletes the correct (current) line each time": (
        "one\ntwo\nthree\nfour\n", [b"dd", b"."], "three\nfour\n",
    ),
    "2dd from a middle line deletes exactly those two lines": (
        "aa\nbb\ncc\ndd\n", [b"j", b"2dd"], "aa\ndd\n",
    ),
    # The other (unaffected) branch: deleting the trailing lines still moves the cursor up.
    "2dd from the trailing lines is unaffected (moves cursor up)": (
        "aa\nbb\ncc\ndd\n", [b"jj", b"2dd"], "aa\nbb\n",
    ),
    # Regression checks: plain (non-insert) operator/insert dot-repeat still work.
    "dw dot-repeat regression": (
        "alpha beta\ncharlie delta\n", [b"dw", b"j0", b"."], "beta\ndelta\n",
    ),
    "plain insert dot-repeat regression": (
        "aa\nbb\n", [b"i", b"XY", b"\x1b", b"j0", b"."], "XYaa\nXYbb\n",
    ),
}

failures = []
for name, (text, keys, expected) in cases.items():
    actual = run(text, keys)
    if actual != expected:
        failures.append(f"{name}: expected {expected!r}, got {actual!r}")

if failures:
    raise SystemExit("T130 change-repeat/cursor PTY failed:\n" + "\n".join(failures))
print(f"T130-CHANGE-REPEAT-PTY pass: {len(cases)} production PTY cases (ciw/cc combined "
      "change-repeat, dd/cc cursor-placement fix and its unaffected sibling branch, "
      "dw/insert regressions)")
