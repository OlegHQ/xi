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


def finish(child: subprocess.Popen[bytes], master: int, captured: bytearray, case: str) -> None:
    deadline = time.monotonic() + 8
    while child.poll() is None and time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            # The PTY can close just before the child has fully exited.
            time.sleep(0.05)
    if child.poll() is None:
        raise SystemExit(f"Xi pid {child.pid} did not exit for {case}: {captured[-3000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-default-line-ending-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\ndefault-line-ending = "crlf"\n', encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", str(ROOT / "apps/xi/src/main.ts")],
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
        finish(child, master, captured, "scratch")
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
        ["bun", str(ROOT / "apps/xi/src/main.ts"), existing.name],
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
        finish(child, master, captured, "existing")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited for existing file: {captured[-3000:]!r}")

    for ending, separator in (("lf", b"\n"), ("crlf", b"\r\n"), ("ff", b"\f"), ("cr", b"\r"), ("nel", "\u0085".encode())):
        config.write_text(f'[editor]\ndefault-line-ending = "{ending}"\n[editor.statusline]\nleft = ["file-line-ending"]\n', encoding="utf-8")
        named = root / f"empty-{ending}.txt"
        named.touch()
        master, slave = pty.openpty()
        child = subprocess.Popen(
            ["bun", str(ROOT / "apps/xi/src/main.ts"), named.name],
            cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        )
        os.close(slave)
        captured = bytearray()
        try:
            wait_ready(master, captured)
            label = f" {ending.upper()} ".encode()
            deadline = time.monotonic() + 3
            while label not in captured and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    captured.extend(os.read(master, 65536))
            if label not in captured:
                raise SystemExit(f"statusline omitted {ending} ending: {captured[-3000:]!r}")
            os.write(master, b"iA\rB\x1b:w\r")
            deadline = time.monotonic() + 8
            while named.stat().st_size == 0 and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    captured.extend(os.read(master, 65536))
            expected = b"A" + separator + b"B" + separator
            if named.read_bytes() != expected:
                raise SystemExit(f"empty named file used wrong {ending} ending: {named.read_bytes()!r}; output={captured[-3000:]!r}")
            os.write(master, b":q!\r")
            finish(child, master, captured, ending)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited for {ending}: {captured[-3000:]!r}")

print("Config default-line-ending PTY passed: scratch and empty named files use configured endings, statusline names each ending, and existing LF metadata is preserved.")
