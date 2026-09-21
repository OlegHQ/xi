#!/usr/bin/env python3
"""Check the pinned Helix master trust prompt and persistent restricted indicator."""
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

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = ROOT / ".artifacts/reference/helix/master"
HELIX = REFERENCE / "target/release/hx"
assert subprocess.check_output(["git", "-C", str(REFERENCE), "rev-parse", "HEAD"], text=True).strip() == "079a789e8cb08ead67f19e1971a1b7438b37354b"
assert "079a789e" in subprocess.check_output([str(HELIX), "--version"], text=True)


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return


with tempfile.TemporaryDirectory(prefix="xi-helix-trust-reference-") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    workspace = root / "workspace"
    (workspace / ".helix").mkdir(parents=True)
    (workspace / ".helix/config.toml").write_text('[editor]\nline-number = "relative"\n', encoding="utf-8")
    (workspace / "main.txt").write_text("hello\n", encoding="utf-8")
    environment = os.environ.copy()
    environment.update({"HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share"), "TERM": "xterm-256color", "HELIX_RUNTIME": str(REFERENCE / "runtime")})
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    child = subprocess.Popen([str(HELIX), "main.txt"], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    captured = bytearray()
    screen = Screen(14, 100)
    try:
        read_for(master, captured, 2)
        screen.feed(captured)
        rows = "\n".join(screen.row_text(row) for row in range(1, 15))
        if "Trust this workspace?" not in rows or "Never" not in rows or "[⚠]" not in rows:
            raise SystemExit(f"T036-WORKSPACE-TRUST-PROMPT-HELIX-PTY-01 pinned Helix prompt/status missing: {rows!r}")
        os.write(master, b"\x1b")
        captured.clear()
        read_for(master, captured, 1)
        screen.feed(captured)
        rows = "\n".join(screen.row_text(row) for row in range(1, 15))
        if "Trust this workspace?" in rows or "[⚠]" not in rows:
            raise SystemExit(f"T036-WORKSPACE-TRUST-PROMPT-HELIX-PTY-02 pinned Helix restricted status did not persist after Escape: {rows!r}")
        os.write(master, b":q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"T036-WORKSPACE-TRUST-PROMPT-HELIX-PTY-03 pinned Helix exited {child.returncode}")

print("Pinned Helix master prompt and restricted status passed.")
