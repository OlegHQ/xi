#!/usr/bin/env python3
"""Prove editor.shell changes a real :sh command through Xi's task process path."""
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
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-shell-pty-") as temporary:
    root = Path(temporary)
    source = root / "main.txt"
    source.write_text("shell test\n", encoding="utf-8")
    output = root / "shell-output.txt"
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nshell = ["python3", "-c"]\n', encoding="utf-8")
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

        command = f"import pathlib; pathlib.Path({str(output)!r}).write_text('shell-ok')"
        os.write(master, f":sh {command}\r".encode())
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not output.exists():
            read_for(master, captured, 0.05)
        if not output.exists() or output.read_text(encoding="utf-8") != "shell-ok":
            raise SystemExit(f"configured shell did not execute the command: {captured[-5000:]!r}")
        if b"XI_SHELL_EXITED" not in captured:
            read_for(master, captured, 1)
        os.write(master, b"\x1b:wq\r")
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if child.poll() is None:
            raise SystemExit(f"Xi did not exit after :wq: {captured[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")

print("T036 editor.shell PTY passed: :sh used the configured shell command through the production task path.")
