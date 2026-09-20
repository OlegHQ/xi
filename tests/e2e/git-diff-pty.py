#!/usr/bin/env python3
"""Exercise a distinct Git comparison tab and save an edit through the real CLI."""
from __future__ import annotations

import fcntl
import os
import pty
import re
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
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-5000:]!r}")


def git(cwd: str, *args: str) -> None:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr}")


with tempfile.TemporaryDirectory(prefix="xi-git-diff-pty-") as temporary:
    git(temporary, "init", "-q")
    git(temporary, "config", "user.email", "test@example.com")
    git(temporary, "config", "user.name", "Test")
    target = Path(temporary) / "file.txt"
    target.write_text("one\ntwo\nthree\n", encoding="utf-8")
    git(temporary, "add", "file.txt")
    git(temporary, "commit", "-q", "-m", "initial")
    # Modify on disk only (worktree change, not staged) so `Space v d` opens the worktree diff.
    target.write_text("one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(target)],
        cwd=temporary, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b"\x1b")  # ensure Normal mode
        read_for(master, captured, 0.1)
        os.write(master, b" vd")  # Space v d
        read_until(master, captured, b"XI_GIT_DIFF_OPEN", 5)
        read_until(master, captured, b"XI_GIT_DIFF_READY", 5)
        read_for(master, captured, 0.3)
        for chord in (b"\x17s", b"\x17v"):
            start = len(captured)
            os.write(master, chord)
            read_for(master, captured, 0.5)
            if b"XI_WORKBENCH_SPLIT" not in captured[start:]:
                raise SystemExit(f"comparison swallowed split chord {chord!r}: {captured[-1500:]!r}")
            os.write(master, b":q\r")
            read_for(master, captured, 0.3)
            if b"XI_WORKBENCH_VIEW_CLOSED" not in captured[start:]:
                raise SystemExit("split did not close with :q")
        os.write(master, b" vd")
        read_for(master, captured, 0.3)
        before = captured[:]
        os.write(master, b"]c")
        read_for(master, captured, 0.2)
        if b"XI_GIT_DIFF_HUNK" not in captured[len(before):]:
            raise SystemExit("no new output after ]c hunk navigation")

        os.write(master, b"iEDIT with spaces []")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.1)
        os.write(master, b":w\r")
        deadline = time.monotonic() + 5
        expected = "one\nEDIT with spaces []TWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
        while target.read_text(encoding="utf-8") != expected and time.monotonic() < deadline:
            read_for(master, captured, 0.1)
        if target.read_text(encoding="utf-8") != expected:
            raise SystemExit(f"comparison edit/save failed: {target.read_text(encoding='utf-8')!r}; {captured[-1800:]!r}")
        os.write(master, b"\x1b")
        read_until(master, captured, b"XI_GIT_DIFF_CLOSED", 5)
        os.write(master, b":qa!\r")
        # Keep draining terminal output while quitting: a full PTY output buffer can
        # otherwise block the final repaint/terminal cleanup before process exit.
        quit_deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < quit_deadline:
            read_for(master, captured, 0.05)
        try:
            child.wait(timeout=0.1)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"git diff PTY did not quit: {captured[-7000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        artifact = ROOT / '.artifacts/e2e/git-diff.ansi'
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes(captured)
    if child.returncode != 0:
        raise SystemExit(f"git diff PTY exited {child.returncode}: {captured[-7000:]!r}")
    print("Git diff PTY passed comparison tab, first-change navigation, editing spaces/brackets, exact saved bytes and close to file tab")
