#!/usr/bin/env python3
"""Exercise the production right-click context menu (T129): visible, keyboard-reachable,
rejects a disabled action, and its enabled action does what the equivalent click does."""
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
PANEL_POINTER = re.compile(rb"XI_PANEL_POINTER (\{[^\r\n]*\})")


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


def mouse(button: int, x: int, y: int, kind: str = "M") -> bytes:
    return f"\x1b[<{button};{x};{y}{kind}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t129-context-menu-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    target = workspace / "zztarget.txt"
    target.write_text("CONTEXT_MENU_TARGET_MARKER\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
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
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        # Files starts already expanded, so clicking its chevron here would collapse the
        # inline tree instead of opening it; use the same leader shortcut
        # tests/e2e/t040-explorer-pty.py uses to open it instead.
        os.write(master, b" vf")
        read_until(master, captured, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, 1.0)

        # Right-click the root row (mouse row 3: row 1 is the sidebar's `▾ Files` header, row 2
        # is the Explorer panel's own "N items" line, row 3 is the expanded workspace root --
        # a directory-like container): the menu must show "Expand"/"Collapse" enabled and
        # "Open" disabled, and the disabled "Open" must not execute.
        before = len(captured)
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, "m"))
        read_for(master, captured, 0.5)
        hit = next((m for m in (PANEL_POINTER.finditer(bytes(captured[before:]))) if b'"action":"context"' in m.group(0)), None)
        if hit is None:
            raise SystemExit(f"right-click did not produce a context action: {captured[before:][-4000:]!r}")
        screen = captured[before:].decode("utf-8", errors="replace")
        if "Open" not in screen or ("Expand" not in screen and "Collapse" not in screen):
            raise SystemExit(f"context menu did not render both items: {screen[-2000:]!r}")
        # "Open" is the first, disabled item at this menu's top row; Enter must be a no-op for it.
        before_enter = len(captured)
        os.write(master, b"\r")
        read_for(master, captured, 0.4)
        if b"XI_EXPLORER_OPEN" in bytes(captured[before_enter:]) or b"main.ts" in bytes(captured[before_enter:]):
            raise SystemExit(f"Enter activated a disabled context menu item: {captured[before_enter:][-2000:]!r}")
        # Move to the enabled second item and activate it via keyboard; it must behave exactly
        # like the equivalent left-click (root toggles between expanded/collapsed).
        os.write(master, b"\x1b[B")  # Down arrow
        read_for(master, captured, 0.2)
        before_toggle = len(captured)
        os.write(master, b"\r")
        read_for(master, captured, 0.5)
        if b"XI_EXPLORER_REFRESH" not in bytes(captured[before_toggle:]):
            raise SystemExit(f"keyboard-activated context menu item did not toggle the root: {captured[before_toggle:][-2000:]!r}")

        # Right-click the file row (zztarget.txt, mouse row 5: row 4 is main.ts): "Open" is
        # enabled and does exactly what a left-click activation does — opens the file in the
        # editor.
        read_for(master, captured, 0.3)
        before_file = len(captured)
        os.write(master, mouse(2, 5, 5))
        os.write(master, mouse(2, 5, 5, "m"))
        read_for(master, captured, 0.5)
        file_hit = next((m for m in PANEL_POINTER.finditer(bytes(captured[before_file:])) if b'"action":"context"' in m.group(0)), None)
        if file_hit is None:
            raise SystemExit(f"right-click on the file row produced no context action: {captured[before_file:][-4000:]!r}")
        os.write(master, b"\r")
        read_for(master, captured, 0.6)
        if b"ONTEXT_MENU_TARGET_MARKER" not in bytes(captured[before_file:]):
            raise SystemExit(f"activating the enabled 'Open' menu item did not open the file: {captured[before_file:][-4000:]!r}")

        # Reopen a menu (right-click the root again) and click well outside it (over the status
        # bar): the backdrop must dismiss the menu on that click rather than letting it fall
        # through to whatever renderable is under the pointer. Explorer is already open and
        # expanded from the earlier ` vf` (clicking the `▾ Files` chevron again here would
        # collapse -- not reopen -- the already-expanded section).
        before_reopen = len(captured)
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, "m"))
        read_for(master, captured, 0.4)
        if not any(b'"action":"context"' in m.group(0) for m in PANEL_POINTER.finditer(bytes(captured[before_reopen:]))):
            raise SystemExit(f"could not reopen a context menu for the dismiss-on-outside-click check: {captured[before_reopen:][-3000:]!r}")
        before_outside = len(captured)
        os.write(master, mouse(0, 60, 39))
        os.write(master, mouse(0, 60, 39, "m"))
        read_for(master, captured, 0.4)
        # Enter must now be a no-op: the menu should already be dismissed, not still awaiting activation.
        before_enter_after_dismiss = len(captured)
        os.write(master, b"\r")
        read_for(master, captured, 0.4)
        if b"XI_EXPLORER_REFRESH" in bytes(captured[before_enter_after_dismiss:]):
            raise SystemExit(f"a click outside the menu did not dismiss it: {captured[before_outside:][-3000:]!r}")
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.close(master)

print("T129-CONTEXT-MENU-PTY-01 pass: production right-click menu is visible/keyboard-reachable, rejects a disabled action and runs the enabled one")
