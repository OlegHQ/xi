#!/usr/bin/env python3
"""A restricted workspace prompts once and keeps a visible status hint after dismissal."""
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


def read_until(master: int, captured: bytearray, condition, seconds: float = 8) -> None:
    deadline = time.monotonic() + seconds
    while not condition() and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
    if not condition():
        raise SystemExit(f"condition not reached: {captured[-2500:]!r}")


def rows_for(captured: bytearray) -> str:
    screen = Screen(14, 100)
    screen.feed(captured)
    return "\n".join(screen.row_text(row) for row in range(1, 15))


with tempfile.TemporaryDirectory(prefix="xi-trust-prompt-pty-") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    workspace = root / "workspace"
    (workspace / ".helix").mkdir(parents=True)
    (workspace / ".helix" / "config.toml").write_text('[editor]\nline-number = "relative"\n', encoding="utf-8")
    (workspace / "main.txt").write_text("hello\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.pop("XDG_CONFIG_HOME", None)
    environment.update({"HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, lambda: b"XI_WORKBENCH_READY" in captured and "Trust workspace" in rows_for(captured) and "Never trust workspace" in rows_for(captured))
        os.write(master, b"\x1b")
        captured.clear()
        read_until(master, captured, lambda: "[⚠]" in rows_for(captured) and "Trust workspace" not in rows_for(captured))
        rows = rows_for(captured)
        if "[⚠]" not in rows or "Trust workspace" in rows:
            raise SystemExit(f"restricted status did not persist after dismissal: {rows!r}; output={captured[-2500:]!r}")
        os.write(master, b":q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-2500:]!r}")

    for choice, keys in (("trust", b"\r"), ("never", b"j\r")):
        selected = root / choice
        (selected / ".helix").mkdir(parents=True)
        (selected / ".helix" / "config.toml").write_text('[editor]\nline-number = "relative"\n', encoding="utf-8")
        (selected / "main.txt").write_text("hello\n", encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"], cwd=selected, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            read_until(master, captured, lambda: b"XI_WORKBENCH_READY" in captured and "Trust workspace" in rows_for(captured))
            os.write(master, keys)
            trust_dir = home / ".local/share/xi/workspace_trust"
            read_until(master, captured, lambda: any(f'"path":"{selected}"' in record.read_text(encoding="utf-8") and f'"excluded":{str(choice == "never").lower()}' in record.read_text(encoding="utf-8") for record in trust_dir.glob("*.json")))
            records = list(trust_dir.glob("*.json"))
            if not any(f'"path":"{selected}"' in record.read_text(encoding="utf-8") and f'"excluded":{str(choice == "never").lower()}' in record.read_text(encoding="utf-8") for record in records):
                raise SystemExit(f"{choice} decision was not persisted: {records!r}")
            read_until(master, captured, lambda: b'XI_CONFIG_RELOAD {"ok":true' in captured)
            if choice == "never":
                read_until(master, captured, lambda: "[⚠]" in rows_for(captured))
            rows = rows_for(captured)
            if ("[⚠]" in rows) != (choice == "never"):
                raise SystemExit(f"{choice} restricted status is wrong: {rows!r}")
            os.write(master, b":q!\r")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited after {choice}: {captured[-2500:]!r}")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"], cwd=selected, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            read_until(master, captured, lambda: b"XI_WORKBENCH_READY" in captured and "hello" in rows_for(captured))
            if "Trust workspace" in rows_for(captured):
                raise SystemExit(f"{choice} decision did not suppress the next prompt: {captured[-2500:]!r}")
            os.write(master, b":q!\r")
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)

    (home / ".config/xi").mkdir(parents=True)
    (home / ".config/xi/config.toml").write_text('[editor.workspace-trust]\nlevel = "none"\nprompt = true\n', encoding="utf-8")
    lsp_only = root / "lsp-only"
    lsp_only.mkdir()
    (lsp_only / "main.ts").write_text("const n = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"], cwd=lsp_only, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, lambda: b"XI_WORKBENCH_READY" in captured and "Trust workspace" in rows_for(captured))
        os.write(master, b"\x1b:q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

print("Workspace trust PTY passed: first-open and LSP-only prompts, Escape status, and persisted Trust/Never decisions.")
