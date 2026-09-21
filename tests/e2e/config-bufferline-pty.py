#!/usr/bin/env python3
"""Prove editor.bufferline changes the launched editor's reserved top row."""
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


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def run_case(value: str, row: int) -> None:
    with tempfile.TemporaryDirectory(prefix="xi-bufferline-pty-") as temporary:
        root = Path(temporary)
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(f'schema-version = 1\n[editor]\nbufferline = "{value}"\n', encoding="utf-8")
        source = root / "bufferline.txt"
        source.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
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
                raise SystemExit(f"Xi did not reach the workbench for bufferline={value}: {captured[-4000:]!r}")
            read_for(master, captured, 0.5)
            marker = f"\x1b[{row};30H".encode()
            if marker not in captured or b"  1 \x1b[0m" not in captured[captured.rfind(marker):captured.rfind(marker) + 200]:
                raise SystemExit(f"bufferline={value} rendered the first line at an unexpected row: {captured[-4000:]!r}")
            os.write(master, b"q")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode} for bufferline={value}: {captured[-4000:]!r}")


run_case("never", 1)
run_case("always", 2)
print("Config bufferline PTY passed: never removes and always reserves the tab-strip row.")
