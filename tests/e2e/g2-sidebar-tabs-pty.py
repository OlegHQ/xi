#!/usr/bin/env python3
"""Exercise the production sidebar chevrons, buffer tab strip and sidebar resize splitter
end-to-end (G2): opening a file from the Explorer creates a preview tab that paints bold
while active, opening a second file replaces that preview tab outright (VS Code semantics --
`BufferHost#openBufferAtPath` routes a `preview: true` open through
`WorkbenchSession#replacePreview`), double-clicking a tab pins it so it survives the next
preview replacement, and dragging the sidebar's resize splitter commits a width change.
"""
from __future__ import annotations

import json
import os
import fcntl
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
SPLITTER = re.compile(rb"XI_WORKBENCH_SPLITTER (\{[^\r\n]*\})")
TAB_POINTER = re.compile(rb"XI_TAB_POINTER (\{[^\r\n]*\})")

class Screen:
    """Minimal VT text-only grid (attributes are not tracked -- see t034/sidebar-tabs.test.ts
    for the ITALIC/BOLD assertions this PTY script cannot make from raw text alone)."""

    def __init__(self, rows: int, cols: int) -> None:
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0

    def feed(self, data: bytes) -> None:
        text = data.decode("utf-8", errors="replace")
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                match = re.match(r"\x1b\[([0-9;]*)([A-Za-z])", text[i:])
                if match:
                    self._csi(match.group(1), match.group(2))
                    i += match.end()
                    continue
                match = re.match(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", text[i:])
                if match:
                    i += match.end()
                    continue
                match = re.match(r"\x1bP.*?\x1b\\", text[i:], re.S)
                if match:
                    i += match.end()
                    continue
                i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.r = min(self.rows - 1, self.r + 1)
            elif ch < " " or ch == "\x7f":
                pass
            else:
                if self.c < self.cols:
                    self.grid[self.r][self.c] = ch
                self.c = min(self.cols, self.c + 1)
            i += 1

    def _csi(self, params: str, final: str) -> None:
        parts = [int(value) for value in params.split(";") if value.isdigit()] if params else []
        if final == "H" or final == "f":
            self.r = max(0, (parts[0] if parts else 1) - 1)
            self.c = max(0, (parts[1] if len(parts) > 1 else 1) - 1)
        # Colors/attributes (`m`) and everything else are irrelevant to this text-only probe.

    def row_text(self, row: int) -> str:
        return "".join(self.grid[row]).rstrip()


def read_for(master: int, captured: bytearray, screen: Screen, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        captured.extend(chunk)
        screen.feed(chunk)


def read_until(master: int, captured: bytearray, screen: Screen, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, screen, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def click(master: int, captured: bytearray, screen: Screen, x: int, y: int, wait: float = 0.2) -> None:
    os.write(master, mouse(0, x, y))
    os.write(master, mouse(0, x, y, True))
    read_for(master, captured, screen, wait)


def open_from_explorer(master: int, captured: bytearray, screen: Screen, filename: str) -> None:
    """Click Explorer rows (4..13, 1-based mouse rows) until `filename` shows up in the tab
    strip; mirrors tests/e2e/t127-panel-pointer-pty.py's stable-row probing, but confirms
    success against the tab strip (the ground truth this fixture cares about) rather than the
    Explorer's own `selectedPath`, which does not always re-fire for an already-open file. Row
    3 is the workspace root directory row (the Explorer panel now nests inline below the
    sidebar's own `▾ Files` header and its own "N items" line) -- clicking it would toggle it
    closed instead of opening a file, so the probe starts one row lower, at the first child."""
    for row in range(4, 14):
        if filename in tab_row(screen):
            return
        click(master, captured, screen, 5, row, wait=0.3)
        if filename in tab_row(screen):
            return
    raise SystemExit(f"never activated {filename!r} from the Explorer: {captured[-4000:]!r}")


def tab_row(screen: Screen) -> str:
    return screen.row_text(0)


with tempfile.TemporaryDirectory(prefix="xi-g2-sidebar-tabs-") as temporary:
    workspace = Path(temporary)
    (workspace / "a.txt").write_text("alpha\n", encoding="utf-8")
    (workspace / "b.txt").write_text("bravo\n", encoding="utf-8")
    (workspace / "c.txt").write_text("charlie\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nbufferline = "always"\n', encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": "", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts")],
        cwd=str(workspace),
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    screen = Screen(40, 120)
    try:
        read_until(master, captured, screen, b"XI_WORKBENCH_READY", 10)

        # Open the Explorer through the same leader shortcut tests/e2e/t040-explorer-pty.py
        # uses (Files starts already expanded -- clicking its chevron now would collapse
        # it, since the click toggles the section's inline visibility since this ticket).
        os.write(master, b" vf")
        read_until(master, captured, screen, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, screen, 0.6)

        # G2-01: opening a.txt from the Explorer creates a preview tab, active (bold, on an
        # accent background) since it is the only/newest one.
        before_a = len(captured)
        open_from_explorer(master, captured, screen, "a.txt")
        header_after_a = tab_row(screen)
        if "a.txt" not in header_after_a:
            raise SystemExit(f"a.txt did not appear in the tab strip: {header_after_a!r}")
        if b"\x1b[1m" not in captured[before_a:]:
            raise SystemExit("the newly active a.txt tab was not painted bold")

        # G2-02: opening b.txt replaces the a.txt preview tab outright -- one preview tab
        # occupies the strip at a time, not two -- and the new tab paints bold/active.
        before_b = len(captured)
        open_from_explorer(master, captured, screen, "b.txt")
        header_after_b = tab_row(screen)
        if "b.txt" not in header_after_b:
            raise SystemExit(f"b.txt did not appear in the tab strip: {header_after_b!r}")
        if "a.txt" in header_after_b:
            raise SystemExit(f"the a.txt preview tab was not replaced by b.txt: {header_after_b!r}")
        if b"\x1b[1m" not in captured[before_b:]:
            raise SystemExit("the newly active b.txt tab was not painted bold")

        # G2-03: double-clicking the active tab (b.txt) pins it -- find its column from the
        # header text, then send two rapid clicks at that column on row 1 (1-based).
        column = header_after_b.index("b.txt") + 1
        before_pin = len(captured)
        click(master, captured, screen, column, 1, wait=0.05)
        click(master, captured, screen, column, 1, wait=0.3)
        pin_events = [json.loads(match.group(1)) for match in TAB_POINTER.finditer(captured[before_pin:])]
        if not any(event.get("clickCount", 0) >= 2 for event in pin_events):
            raise SystemExit(f"double-click on the tab was not recognized as a pin: {pin_events!r}")

        # G2-04: opening c.txt keeps the now-pinned b.txt open (pinning takes it out of the
        # preview slot, so it is never replaced) and adds c.txt as a new preview tab.
        open_from_explorer(master, captured, screen, "c.txt")
        header_after_c = tab_row(screen)
        if not all(name in header_after_c for name in ("b.txt", "c.txt")):
            raise SystemExit(f"pinned b.txt and new preview c.txt did not both survive: {header_after_c!r}")

        # G2-05: dragging the sidebar's resize splitter changes SidebarController's width --
        # verified through the `XI_WORKBENCH_SPLITTER` marker (a committed `sidebar` resize),
        # the same production event the pointer router already emits for editor-pane splitters.
        before_drag = len(captured)
        os.write(master, mouse(0, 29, 5))
        read_for(master, captured, screen, 0.1)
        os.write(master, mouse(0, 33, 5))
        read_for(master, captured, screen, 0.1)
        os.write(master, mouse(0, 37, 5, True))
        read_for(master, captured, screen, 0.4)
        splitter_events = [json.loads(match.group(1)) for match in SPLITTER.finditer(captured[before_drag:])]
        sidebar_events = [event for event in splitter_events if event.get("nodeId") == "sidebar"]
        if not any(event.get("action") == "begin" for event in sidebar_events):
            raise SystemExit(f"sidebar splitter drag never began: {splitter_events!r}")
        committed = [event for event in sidebar_events if event.get("action") == "commit"]
        if not committed or committed[-1].get("committed") is not True:
            raise SystemExit(f"sidebar splitter drag never committed: {splitter_events!r}")

        # G2-06: the Outline header is the Files/Outline splitter. Expand Outline by clicking its
        # collapsed header (bottom row), then jump the header up over the Files rows in one move:
        # the press captured the pointer, so the drag resizes instead of reaching the tree.
        click(master, captured, screen, 5, 39)
        before_fast = len(captured)
        os.write(master, mouse(0, 5, 25))
        read_for(master, captured, screen, 0.1)
        os.write(master, mouse(32, 5, 15))
        read_for(master, captured, screen, 0.1)
        os.write(master, mouse(0, 5, 15, True))
        read_for(master, captured, screen, 0.4)
        fast = [json.loads(match.group(1)) for match in SPLITTER.finditer(captured[before_fast:])]
        if not any(event.get("nodeId") == "outline" and event.get("action") == "move" and event.get("firstSize") == 24 for event in fast):
            raise SystemExit(f"a fast Outline header drag over the Files rows lost the splitter capture: {fast!r}")

        os.write(master, b"\x1b")
        read_for(master, captured, screen, 0.2)
        os.write(master, b":qa!\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"g2 sidebar/tabs PTY did not quit: {captured[-4000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

print("G2-SIDEBAR-TABS-PTY-01 pass: Explorer-opened preview tabs paint bold when active and "
      "replace the prior preview tab, double-click pins a tab so it survives the next "
      "replacement, and the sidebar splitter drag commits a resize")
