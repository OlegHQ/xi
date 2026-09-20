#!/usr/bin/env python3
"""T130: dot-repeat ('.') through the production CLI.

Root cause of the original gap: packages/vim/repeat/index.ts's semantic dot-repeat engine
(T024, oracle-verified) and packages/workbench/vim-session/index.ts (the production
dispatcher every keystroke actually goes through) never called each other at all -- bare '.'
silently did nothing, and macro record/playback ('q'/'@') is separately still unwired (that
remains open T130 scope; see docs/vim.md).

This fixture proves the wired subset through real production PTY sessions, single cursor
only, matching exactly what T024's own model supports:
  - operator+motion/text-object delete (e.g. 'dw', 'diw') repeats at a new cursor position.
  - a plain insert session (entry key + typed text + Escape) repeats its typed text.
  - repeated '.' presses each resolve against the *current* cursor, not a stale one.
  - a Ctrl-C-interrupted insert is not recorded; the previous target survives.
  - '.' with no prior target is a safe no-op (no crash, no message-loop hang).
  - a direct-change key ('x') has no repeat-target kind in T024's model at all; '.' after it
    is correctly a no-op too, not a crash -- a disclosed limitation, not a defect.
"""
from __future__ import annotations

import fcntl
import os
import pty
import struct
import subprocess
import select
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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


def run(text: str, keys: list[bytes]) -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t130-dot-") as temporary:
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
            read_for(master, captured, 3)
            for key in keys:
                os.write(master, key)
                read_for(master, captured, 0.2)
            os.write(master, b":wq\r")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        return source.read_text(encoding="utf-8")


cases: dict[str, tuple[str, list[bytes], str]] = {
    "operator-motion (dw . on the next line)": (
        "alpha beta\ncharlie delta\n", [b"dw", b"j0", b"."], "beta\ndelta\n",
    ),
    "operator-text-object (diw . on the next line)": (
        "alpha beta\ncharlie delta\n", [b"diw", b"j0", b"."], " beta\n delta\n",
    ),
    "insert (i TEXT Esc . on the next line)": (
        "aa\nbb\n", [b"i", b"XY", b"\x1b", b"j0", b"."], "XYaa\nXYbb\n",
    ),
    "repeated dot across three lines": (
        "a b\nc d\ne f\ng h\n", [b"dw", b"j0", b".", b"j0", b"."], "b\nd\nf\ng h\n",
    ),
    "no prior target is a safe no-op": ("a b\n", [b"."], "a b\n"),
    "Ctrl-C interrupted insert is not recorded": (
        "aa\nbb\ncc\n",
        [b"i", b"ZZ", b"\x03", b"j0", b"i", b"QQ", b"\x1b", b"j0", b"."],
        "ZZaa\nQQbb\nQQcc\n",
    ),
    "direct-change key ('x') has no repeat target: safe no-op, not a crash": (
        "hello world\nhello world\n", [b"gg0x", b"j0", b"."], "ello world\nhello world\n",
    ),
}

failures = []
for name, (text, keys, expected) in cases.items():
    actual = run(text, keys)
    if actual != expected:
        failures.append(f"{name}: expected {expected!r}, got {actual!r}")

if failures:
    raise SystemExit("T130 dot-repeat PTY failed:\n" + "\n".join(failures))
print(f"T130-DOT-REPEAT-PTY pass: {len(cases)} production PTY cases (operator/insert repeat, "
      "repeated dot, no-target, Ctrl-C non-recording, and direct-change-key non-target)")
