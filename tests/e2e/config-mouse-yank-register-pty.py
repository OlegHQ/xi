#!/usr/bin/env python3
"""Prove editor.mouse-yank-register through a real launched Xi pointer drag."""
from __future__ import annotations

import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POINTER = re.compile(rb"XI_POINTER_STATE (\{[^\r\n]*\})")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-mouse-yank-register-pty-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.txt"
    source.write_text("junk\nalpha beta\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nmouse-yank-register = "a"\n', encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
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
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")

        # The first editable row is reached at terminal row 2 and column 8 in the
        # production pointer path used by the PTY harness.
        before = len(captured)
        os.write(master, mouse(0, 8, 2) + mouse(32, 12, 2) + mouse(0, 12, 2, True))
        read_for(master, captured, 0.5)
        states = [match.group(1) for match in POINTER.finditer(captured[before:])]
        if not states:
            raise SystemExit(f"production drag did not reach the pointer owner: {captured[-5000:]!r}")

        # Leave Visual mode, paste explicitly from the configured register, then save/quit.
        os.write(master, b'\x1b"ap:wq\r')
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if child.poll() is None:
            raise SystemExit(f"Xi did not exit after :wq: {captured[-4000:]!r}")
        if source.read_text(encoding="utf-8") != "junk\nalphaalpha beta\n":
            raise SystemExit(f"configured mouse yank register was not read back: {source.read_text(encoding='utf-8')!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")

print("T036 mouse-yank-register PTY passed: a production drag was read back from the configured register.")
