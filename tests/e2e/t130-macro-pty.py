#!/usr/bin/env python3
"""T130: macro record/playback ('q'/'@') through the production CLI.

Real Vim starts a recording with bare 'q'+register and stops with bare 'q' alone. Xi's own
'q' is already a shipped, extensively-tested quick-quit shortcut; removing it for real Vim's
start-recording trigger would be a much larger, riskier change than this ticket's own scope
("wire the existing tested engine in"), so starting a recording is exposed through the
leader-key layer instead: '<space>q<register>'. Stopping (bare 'q' while a recording is
already active, which has no conflict with quit) and playback ('@<register>'/'@@') use their
real, unmodified Vim keys and are unaffected by that substitution.

This fixture proves, through real production PTY sessions:
  - a clean-buffer bare 'q' still quits immediately (the pre-existing shortcut, unchanged).
  - a dirty-buffer bare 'q' still refuses.
  - '<space>q' + an invalid "register" key (Escape) does not start a recording or crash.
  - '<space>qa' records into register a; 'x' during recording is both applied live and
    captured; bare 'q' stops it; '@a' replays the captured keys at a new cursor position.
  - '@@' (repeat-last) replays the same macro again without naming its register.
  - an explicit count before '@' ('2@a') replays the macro that many times in one call.
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


def run(text: str, keys: list[bytes], quit_keys: bytes = b":wq\r") -> tuple[str, bool]:
    with tempfile.TemporaryDirectory(prefix="xi-t130-macro-") as temporary:
        source = Path(temporary) / "m.txt"
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
            if quit_keys:
                send_key(master, captured, quit_keys)
            try:
                child.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
            still_running = child.poll() is None
            if still_running and quit_keys:
                send_key(master, captured, b":q!\r")
                child.wait(timeout=3)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        return source.read_text(encoding="utf-8"), still_running


failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{name}: expected {expected!r}, got {actual!r}")


# Clean-buffer bare 'q' still quits immediately -- the pre-existing shortcut is unchanged.
_, still_running = run("hello\n", [b"q"], quit_keys=b"")
check("clean-buffer bare q quits", still_running, False)

# Dirty-buffer bare 'q' still refuses.
_, still_running = run("hello\n", [b"iXXX\x1b", b"q"], quit_keys=b"")
check("dirty-buffer bare q refuses", still_running, True)

# '<space>q' + an invalid register (Escape) must not start a recording or crash.
text, _ = run("hello\n", [b" q", b"\x1b", b"x"])
check("invalid register after <space>q is a safe no-op, then x still works", text, "ello\n")

# Record 'x' into register a; replay it with '@a' at a new position.
text, _ = run(
    "hello world\nhello world\nhello world\n",
    [b" qa", b"x", b"q", b"j0", b"@a"],
)
check("record x into a, @a on the next line", text, "ello world\nello world\nhello world\n")

# '@@' repeats the last-executed macro without naming its register.
text, _ = run(
    "hello world\nhello world\nhello world\n",
    [b" qa", b"x", b"q", b"j0", b"@a", b"j0", b"@@"],
)
check("@a then @@ repeat-last", text, "ello world\nello world\nello world\n")

# A count before '@' replays the macro that many times in one call.
text, _ = run("aaaa bbbb cccc\n", [b" qa", b"x", b"q", b"2@a"])
check("2@a replays twice (plus the one live edit while recording)", text, "a bbbb cccc\n")

if failures:
    raise SystemExit("T130 macro PTY failed:\n" + "\n".join(failures))
print("T130-MACRO-PTY pass: quit-shortcut regression checks, invalid-register safety, "
      "record+replay, @@ repeat-last, and counted replay -- all through the production CLI")
