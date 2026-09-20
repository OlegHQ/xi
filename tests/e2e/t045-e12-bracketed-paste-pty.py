#!/usr/bin/env python3
"""T045/E12: bracketed paste through the production CLI.
docs/testing.md's E12 row: "Legacy/enhanced keys, bracketed paste, required
supported mouse protocols" -> "One event delivery, no pasted commands, no Ctrl-C accidental
exit." Before this fixture, Xi never consumed OpenTUI's own `paste` event at all -- pasted
bytes had zero effect (safe, but non-functional). This exercises the new wiring
(packages/ui/src/terminal.ts's onPaste -> apps/xi/src/main.ts -> OwnedVimSession.handlePaste
-> planVimMultiInsertInput's {kind:'paste', ...} input) end to end.

Two cases:
1. Pasting a real bracketed-paste sequence whose payload contains a dangerous-looking
   embedded Ex command (":wq!\r") and a Ctrl-C byte while in Insert mode must insert the
   bytes literally as text -- it must never execute ":wq!" or exit on the embedded Ctrl-C.
   This is the "no pasted commands" and "no Ctrl-C accidental exit" half of E12.
2. Pasting while in Normal mode must be a safe no-op (disclosed limitation: only
   Insert/Replace/Virtual-replace consume paste today) -- it must not crash and must not
   change the buffer.
"""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
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


def read_until_count(master: int, captured: bytearray, marker: bytes, count: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while captured.count(marker) < count and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if captured.count(marker) < count:
        raise SystemExit(f"missing PTY marker {marker!r} count={count}: {captured[-6000:]!r}")


def bracketed_paste(payload: bytes) -> bytes:
    return b"\x1b[200~" + payload + b"\x1b[201~"


with tempfile.TemporaryDirectory(prefix="xi-t045-e12-") as temporary:
    source = Path(temporary) / "paste.txt"
    source.write_text("start\n", encoding="utf-8")
    master, slave = pty.openpty()
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
        read_until_count(master, captured, b"XI_WORKBENCH_READY", 1, 10)

        # Case 2 first, from Normal mode: must be a safe no-op, no crash, no change.
        dangerous = b"DANGER:wq!\rEND\x03TAIL"
        os.write(master, bracketed_paste(dangerous))
        read_for(master, captured, 0.3)
        if child.poll() is not None:
            raise SystemExit(f"editor exited on a Normal-mode paste: {captured[-4000:]!r}")

        # Case 1: enter Insert mode, then paste the same dangerous payload.
        os.write(master, b"A")
        read_for(master, captured, 0.2)
        before_paste = len(captured)
        os.write(master, bracketed_paste(dangerous))
        read_until_count(master, captured[before_paste:] and captured, b"XI_PASTE", 1, 5)
        read_for(master, captured, 0.3)
        if child.poll() is not None:
            raise SystemExit(f"editor exited while consuming a pasted embedded command/Ctrl-C: {captured[-4000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        os.write(master, b":wq\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    final_text = source.read_text(encoding="utf-8")

# The Ctrl-C byte (0x03) is stripped by the paste decoder's control handling only if it were
# parsed as a key; as an opaque paste byte it must survive as literal text along with the rest.
expected = "start" + dangerous.decode("utf-8").replace("\r", "\n") + "\n"
if final_text != expected:
    raise SystemExit(f"pasted bytes were not inserted literally and unexecuted: expected {expected!r}, got {final_text!r}")
print("T045-E12-BRACKETED-PASTE-PTY pass: a bracketed-paste payload containing an embedded "
      "':wq!' and a Ctrl-C byte was inserted as literal text with no command execution and "
      "no accidental exit, in both Normal mode (safe no-op) and Insert mode (literal insertion)")
