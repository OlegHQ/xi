#!/usr/bin/env python3
"""Prove editor.soft-wrap.enable=true changes the launched Xi viewport."""
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
TEXT = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-soft-wrap-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.soft-wrap]\nenable = true\nwrap-indicator = \"↪ \"\n", encoding="utf-8")
    source = root / "soft-wrap.txt"
    source.write_text(TEXT + "\nnext\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 40, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(source)],
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
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        read_for(master, captured, 0.5)
        # The primary cursor paints the first glyph in a separate terminal run, so
        # assert the remainder of the first wrapped segment as one contiguous run.
        first = TEXT[1:36].encode()
        # At 40 columns the compact editor leaves 36 text cells after Xi's 4-cell
        # line-number gutter. A wrapped continuation occupies the next screen row.
        row_one = captured.rfind(b"\x1b[1;6H")
        row_two = captured.rfind(b"\x1b[2;1H")
        if row_one < 0 or first not in captured[row_one:row_one + 500]:
            raise SystemExit(f"soft-wrap first row missing: {captured[-4000:]!r}")
        second = TEXT[36:].encode()
        if row_two < 0 or "↪".encode() not in captured[row_two:row_two + 500] or second not in captured[row_two:row_two + 500]:
            raise SystemExit(f"soft-wrap continuation row missing: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config soft-wrap PTY passed: launched Xi wrapped a long logical line with its configured indicator.")
