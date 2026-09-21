#!/usr/bin/env python3
"""Prove default-line-ending affects new buffers without rewriting existing EOL metadata."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def wait_ready(master: int, captured: bytearray) -> None:
    deadline = time.monotonic() + 10
    while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            break
    if b"XI_WORKBENCH_READY" not in captured:
        raise SystemExit(f"workbench did not start: {captured[-3000:]!r}")


def finish(child: subprocess.Popen[bytes], master: int, captured: bytearray) -> None:
    deadline = time.monotonic() + 8
    while child.poll() is None and time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            break
    if child.poll() is None:
        raise SystemExit(f"Xi did not exit: {captured[-3000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-default-line-ending-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\ndefault-line-ending = "crlf"\n', encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts")],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    target = root / "new.txt"
    try:
        wait_ready(master, captured)
        os.write(master, b"ihello\rworld\x1b:w new.txt\r")
        deadline = time.monotonic() + 8
        while not target.exists() and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if target.read_bytes() != b"hello\r\nworld\r\n":
            raise SystemExit(f"new buffer used wrong line ending: {target.read_bytes()!r}; output={captured[-3000:]!r}")
        os.write(master, b":q!\r")
        finish(child, master, captured)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-3000:]!r}")

    existing = root / "existing.txt"
    existing.write_bytes(b"one\ntwo\n")
    master, slave = pty.openpty()
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), existing.name],
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
        wait_ready(master, captured)
        os.write(master, b"i")
        time.sleep(0.1)
        os.write(master, b"X")
        time.sleep(0.1)
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b"\x13")
        deadline = time.monotonic() + 8
        while existing.read_bytes() == b"one\ntwo\n" and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if existing.read_bytes() != b"Xone\ntwo\n":
            raise SystemExit(f"existing EOL metadata was rewritten: {existing.read_bytes()!r}; output={captured[-3000:]!r}")
        os.write(master, b":q!\r")
        finish(child, master, captured)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited for existing file: {captured[-3000:]!r}")

print("Config default-line-ending PTY passed: new buffers use CRLF and existing LF metadata is preserved.")
