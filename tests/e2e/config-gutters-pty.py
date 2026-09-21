#!/usr/bin/env python3
"""Prove an editor.gutters array changes the launched editor's gutter geometry."""
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


def run_case(root: Path, config_text: str, label: str) -> None:
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(config_text, encoding="utf-8")
    source = root / f"gutters-{label}.txt"
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
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        read_for(master, captured, 0.5)
        if b"  4" not in captured:
            raise SystemExit(f"{label} gutter layout was not rendered: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode} for {label}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-gutters-pty-") as temporary:
    root = Path(temporary)
    run_case(root, 'schema-version = 1\n[editor]\ngutters = ["line-numbers"]\n', "array")
    run_case(root, 'schema-version = 1\n[editor.gutters]\nlayout = ["diff", "diagnostics", "line-numbers"]\n', "layout")

print("Config gutters PTY passed: launched Xi applied both scalar and table gutter layouts.")
