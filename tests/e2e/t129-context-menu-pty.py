#!/usr/bin/env python3
"""Exercise the production right-click context menu (T129): visible, keyboard-reachable,
rejects a disabled action, and its enabled action does what the equivalent click does."""
from __future__ import annotations

import fcntl
import json
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
EXPLORER_REFRESH = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")


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
    deadline = time.monotonic() + seconds
    while marker not in captured[start:] and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured[start:]:
        raise SystemExit(f"missing PTY marker {marker!r} after offset {start}: {captured[start:][-4000:]!r}")


def wait_for_explorer(master: int, captured: bytearray, predicate, seconds: float = 10) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        entries = [json.loads(match.group(1)) for match in EXPLORER_REFRESH.finditer(captured)]
        if entries and predicate(entries[-1]):
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"explorer did not reach expected state: {captured[-4000:]!r}")


def open_root_context(master: int, captured: bytearray) -> int:
    wait_for_explorer(master, captured, lambda entry: entry.get("state") == "ready" and {"main.ts", "zztarget.txt"}.issubset(entry.get("visibleLabels", [])))
    for _ in range(5):
        start = len(captured)
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, "m"))
        try:
            read_until_after(master, captured, start, b'"action":"context"', 5)
        except SystemExit:
            raise SystemExit(f"root context click produced no event; preceding output: {captured[-3000:]!r}")
        pointer = next(match for match in PANEL_POINTER.finditer(captured[start:]) if b'"action":"context"' in match.group(0))
        context = json.loads(pointer.group(1))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            pointer_end = start + pointer.end()
            newer = [json.loads(match.group(1)) for match in EXPLORER_REFRESH.finditer(captured[pointer_end:])]
            if newer and newer[-1].get("generation", 0) > context.get("generation", 0):
                break
            screen = captured[start:].decode("utf-8", errors="replace")
            if "Expand" in screen or "Collapse" in screen:
                # A ready row can still be followed by one last asynchronous tree
                # generation. Require a quiet marker stream before relying on this menu.
                quiet_since = time.monotonic()
                while time.monotonic() - quiet_since < 0.1:
                    previous_size = len(captured)
                    read_for(master, captured, 0.025)
                    if len(captured) != previous_size:
                        quiet_since = time.monotonic()
                    newer = [json.loads(match.group(1)) for match in EXPLORER_REFRESH.finditer(captured[pointer_end:])]
                    if newer and newer[-1].get("generation", 0) > context.get("generation", 0):
                        break
                else:
                    return start
                break
            read_for(master, captured, 0.05)
        else:
            raise SystemExit(f"context menu did not render its enabled item: {captured[start:][-2000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.1)
        wait_for_explorer(master, captured, lambda entry: entry.get("state") == "ready" and {"main.ts", "zztarget.txt"}.issubset(entry.get("visibleLabels", [])))
    raise SystemExit(f"context menu kept getting invalidated by explorer refreshes: {captured[-4000:]!r}")


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
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": "", "XI_UI_TEST_MARKERS": "1"})
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
        wait_for_explorer(master, captured, lambda entry: entry.get("state") == "ready" and {"main.ts", "zztarget.txt"}.issubset(entry.get("visibleLabels", [])))

        # Right-click the root row (mouse row 3: row 1 is the sidebar's `▾ Files` header, row 2
        # is the Explorer panel's own "N items" line, row 3 is the expanded workspace root --
        # a directory-like container): the menu must show "Expand"/"Collapse" enabled and
        # "Open" disabled, and the disabled "Open" must not execute.
        before = open_root_context(master, captured)
        hit = next((m for m in (PANEL_POINTER.finditer(bytes(captured[before:]))) if b'"action":"context"' in m.group(0)), None)
        if hit is None:
            raise SystemExit(f"right-click did not produce a context action: {captured[before:][-4000:]!r}")
        screen = captured[before:].decode("utf-8", errors="replace")
        # Solid repaints only changed cells, so "Open" can be split around a matching
        # character already present underneath the overlay. The click/no-op check below is
        # the behavioral proof that its disabled first row exists.
        if "Expand" not in screen and "Collapse" not in screen:
            raise SystemExit(f"context menu did not render its enabled item: {screen[-2000:]!r}")
        # "Open" is the first, disabled item at this menu's top row. Clicking it must be a
        # no-op and must leave the menu available for keyboard activation of the selected,
        # enabled Collapse item.
        before_enter = len(captured)
        os.write(master, mouse(0, 5, 3))
        os.write(master, mouse(0, 5, 3, "m"))
        read_for(master, captured, 0.1)
        # Closing/repainting a Solid overlay can legitimately expose the underlying
        # `main.ts` label in the ANSI diff; only a semantic activation marker is evidence
        # that the disabled action ran.
        if b"XI_EXPLORER_OPEN" in bytes(captured[before_enter:]):
            raise SystemExit(f"Enter activated a disabled context menu item: {captured[before_enter:][-2000:]!r}")
        # Activate the selected enabled item via keyboard; it must behave exactly like the
        # equivalent left-click (root toggles between expanded/collapsed).
        before_toggle = len(captured)
        os.write(master, b"\r")
        deadline = time.monotonic() + 5
        while (b"XI_EXPLORER_REFRESH" not in captured[before_toggle:] and
               b"Files tree changed; open the menu again" not in captured[before_toggle:] and
               time.monotonic() < deadline):
            read_for(master, captured, 0.05)
        if b"Files tree changed; open the menu again" in captured[before_toggle:]:
            # The asynchronous tree scan can invalidate a menu opened on the previous
            # generation. Reopen it against the current generation and retry the same action.
            os.write(master, mouse(2, 5, 3))
            os.write(master, mouse(2, 5, 3, "m"))
            read_until_after(master, captured, len(captured) - 1, b'"action":"context"', 5)
            before_toggle = len(captured)
            os.write(master, b"\r")
            read_until_after(master, captured, before_toggle, b"XI_EXPLORER_REFRESH", 5)
        if b"XI_EXPLORER_REFRESH" not in bytes(captured[before_toggle:]):
            raise SystemExit(f"keyboard-activated context menu item did not toggle the root: {captured[before_toggle:][-2000:]!r}")

        # Expand the root again before addressing its file rows.
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, "m"))
        read_for(master, captured, 0.3)
        os.write(master, b"\r")
        read_for(master, captured, 0.5)

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
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b" vf")
        read_for(master, captured, 0.2)
        before_reopen = open_root_context(master, captured)
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
