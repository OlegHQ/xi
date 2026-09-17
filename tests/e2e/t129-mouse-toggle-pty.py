#!/usr/bin/env python3
"""Exercise the production mouse-mode toggle (T129): it flips the renderer's own SGR mouse
reporting modes and clicks keep working once toggled back on. Covers both the leader
keybinding and the searchable command-palette entry (`;` picker, "Toggle Mouse")."""
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
MOUSE_MODE = re.compile(rb"XI_MOUSE_MODE (\{[^\r\n]*\})")


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


def read_until_after(master: int, captured: bytearray, start: int, marker: bytes, seconds: float) -> None:
    """Like read_until, but only counts an occurrence at or after `start` — needed when the
    same marker text can legitimately repeat (e.g. toggling mouse mode off and back on)."""
    deadline = time.monotonic() + seconds
    while marker not in captured[start:] and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured[start:]:
        raise SystemExit(f"missing PTY marker {marker!r} after offset {start}: {captured[start:][-5000:]!r}")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def spawn(workspace: Path):
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=str(workspace),
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    return master, child


def close(master: int, child) -> None:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)


def run_keybinding_toggle() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t129-mouse-toggle-") as temporary:
        master, child = spawn(Path(temporary))
        captured = bytearray()
        try:
            read_until(master, captured, b"XI_WORKBENCH_READY", 10)
            # Sanity: a click reaches the workbench (Files sidebar control) while mouse mode is on.
            before = len(captured)
            os.write(master, mouse(0, 3, 1))
            os.write(master, mouse(0, 3, 1, True))
            read_until(master, captured, b"XI_WORKBENCH_CONTROL", 5)
            # That click opened the Explorer sidebar, which captures subsequent keys; close it so
            # the leader-key mouse toggle below reaches the global dispatcher instead.
            os.write(master, b"\x1b")
            read_for(master, captured, 0.3)
            # Toggle mouse mode off (` m`): production terminal state must actually withdraw SGR
            # mouse reporting (modes 1000/1002/1006 disabled), not just flip an inert flag.
            before = len(captured)
            os.write(master, b" m")
            read_until_after(master, captured, before, b"XI_MOUSE_MODE", 5)
            toggled = MOUSE_MODE.search(bytes(captured[before:]))
            if toggled is None or b'"enabled":false' not in toggled.group(1):
                raise SystemExit(f"mouse toggle did not report disabled: {captured[before:][-2000:]!r}")
            if not re.search(rb"\x1b\[\?100[026]l", bytes(captured[before:])):
                raise SystemExit(f"mouse toggle off did not withdraw SGR mouse reporting modes: {captured[before:][-2000:]!r}")
            # Toggle back on: reporting modes are re-enabled and clicks work again.
            before = len(captured)
            os.write(master, b" m")
            read_until_after(master, captured, before, b"XI_MOUSE_MODE", 5)
            toggled_on = MOUSE_MODE.search(bytes(captured[before:]))
            if toggled_on is None or b'"enabled":true' not in toggled_on.group(1):
                raise SystemExit(f"mouse toggle did not report re-enabled: {captured[before:][-2000:]!r}")
            if not re.search(rb"\x1b\[\?100[026]h", bytes(captured[before:])):
                raise SystemExit(f"mouse toggle on did not re-enable SGR mouse reporting modes: {captured[before:][-2000:]!r}")
            before = len(captured)
            os.write(master, mouse(0, 15, 1))
            os.write(master, mouse(0, 15, 1, True))
            read_until_after(master, captured, before, b"XI_WORKBENCH_CONTROL", 5)
        finally:
            close(master, child)
    print("T129-MOUSE-TOGGLE-PTY-01 pass: leader keybinding withdraws and restores SGR reporting, and clicks keep working once re-enabled")


def run_command_palette_toggle() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t129-mouse-toggle-palette-") as temporary:
        master, child = spawn(Path(temporary))
        captured = bytearray()
        try:
            read_until(master, captured, b"XI_WORKBENCH_READY", 10)
            # Open the searchable command palette (`;`) and confirm "Toggle Mouse" is listed —
            # this is the "searchable Toggle mouse command" docs/plan/09-interaction.md calls for,
            # not just a bare keybinding.
            before = len(captured)
            os.write(master, b" ;")
            read_until_after(master, captured, before, b"Commands  >", 5)
            read_for(master, captured, 0.3)
            screen = captured[before:].decode("utf-8", errors="replace")
            if "Toggle Mouse" not in screen:
                raise SystemExit(f"command palette did not list Toggle Mouse: {screen[-3000:]!r}")
            # Filter to it and activate with Enter.
            before = len(captured)
            os.write(master, b"Toggle Mouse")
            read_for(master, captured, 0.4)
            os.write(master, b"\r")
            read_until_after(master, captured, before, b"XI_MOUSE_MODE", 5)
            toggled = MOUSE_MODE.search(bytes(captured[before:]))
            if toggled is None or b'"enabled":false' not in toggled.group(1):
                raise SystemExit(f"command-palette toggle did not report disabled: {captured[before:][-3000:]!r}")
            if not re.search(rb"\x1b\[\?100[026]l", bytes(captured[before:])):
                raise SystemExit(f"command-palette toggle did not withdraw SGR mouse reporting modes: {captured[before:][-3000:]!r}")
            # The picker must have closed (not left mid-navigation) after activating the command.
            before = len(captured)
            os.write(master, b" ;")
            os.write(master, b"Toggle Mouse")
            read_for(master, captured, 0.4)
            os.write(master, b"\r")
            read_until_after(master, captured, before, b"XI_MOUSE_MODE", 5)
            toggled_on = MOUSE_MODE.search(bytes(captured[before:]))
            if toggled_on is None or b'"enabled":true' not in toggled_on.group(1):
                raise SystemExit(f"command-palette toggle did not re-enable: {captured[before:][-3000:]!r}")
        finally:
            close(master, child)
    print("T129-MOUSE-TOGGLE-PTY-02 pass: searchable command-palette entry ('Toggle Mouse') withdraws and restores SGR reporting")


run_keybinding_toggle()
run_command_palette_toggle()
