#!/usr/bin/env python3
"""Prove editor.insert-final-newline changes bytes written by the launched editor."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run_case(root: Path, enabled: bool) -> bytes:
    source = root / ("enabled.txt" if enabled else "disabled.txt")
    source.write_bytes(b"hello")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(f"[editor]\ninsert-final-newline = {'true' if enabled else 'false'}\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(root), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), source.name],
        cwd=root,
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
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start for enabled={enabled}: {captured[-3000:]!r}")
        os.write(master, b"A")
        time.sleep(0.1)
        os.write(master, b"X")
        time.sleep(0.1)
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b"\x13")
        expected = b"helloX\n" if enabled else b"helloX"
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and source.read_bytes() != expected:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if source.read_bytes() != expected:
            raise SystemExit(f"insert-final-newline={enabled} wrote {source.read_bytes()!r}, expected {expected!r}; output={captured[-3000:]!r}")
        os.write(master, b":q!\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode} for enabled={enabled}: {captured[-3000:]!r}")
    return source.read_bytes()


with tempfile.TemporaryDirectory(prefix="xi-insert-final-newline-pty-") as temporary:
    root = Path(temporary)
    enabled = run_case(root, True)
    disabled = run_case(root, False)

if enabled != b"helloX\n" or disabled != b"helloX":
    raise SystemExit(f"unexpected final newline cases: enabled={enabled!r}, disabled={disabled!r}")
print("Config insert-final-newline PTY passed: save adds exactly one LF when enabled and preserves missing LF when disabled.")
