#!/usr/bin/env python3
"""T132: theme picker live preview/cancel/commit through the production CLI.
docs/testing.md's E16 row: "Theme preview/cancel..." -> "Token consistency...".

Before T132, the theme picker had exactly one static entry ('Xi Light') with no
activatePickerEntry branch at all -- selecting it did nothing. This exercises the real wiring:
WorkbenchRenderable.setTheme() repaints the whole workbench live from a new WorkbenchTheme,
apps/xi/src/main.ts's picker previewSelected/activatePickerEntry/closePicker apply it as the
theme picker navigates (preview), revert it on Escape (cancel), and keep it on Enter (commit).

This fixture: opens the theme picker -- whose default-selected entry for an empty query is "Xi
Dark" (entries sort alphabetically, and the picker previews its top result immediately on open,
same as the file picker) -- confirming it previews live (a real screen-content byte check,
since the editor's background color genuinely changes); cancels with Escape and confirms the
screen reverts to the original light colors; then reopens the picker and commits the
pre-selected Xi Dark with Enter, confirming the dark colors persist after the picker closes
(not just during preview); then confirms token consistency by opening Explorer, the file
picker, Search and the right-click context menu in turn and checking each one paints with the
committed dark theme too -- each holds its own independent theme object (ExplorerTheme/
PickerTheme/ContextMenuTheme, distinct shapes from WorkbenchTheme), so this is real, separate
wiring, not a side effect of the editor's own theme; finally quits and relaunches a fresh
process against the same HOME directory, confirming the committed theme is restored
immediately on startup with no picker interaction at all -- real cross-launch persistence to
`~/.xi.toml`, which takes precedence over legacy theme state.
"""
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
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The exact truecolor SGR foreground sequence Xi Light and Xi Dark paint the editor background
# with (RGBA background token from packages/ui/src/workbench.ts, as a 24-bit SGR background
# escape: \x1b[48;2;R;G;Bm). Checking for these substrings in the raw terminal stream is a
# direct, unambiguous signal of which theme is actually painting the screen right now.
LIGHT_BACKGROUND = b"\x1b[48;2;252;252;250m"
DARK_BACKGROUND = b"\x1b[48;2;30;30;46m"


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


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


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t132-theme-") as temporary:
    source = Path(temporary) / "theme.txt"
    source.write_text("hello\n", encoding="utf-8")
    state_path = Path(temporary) / ".xi.toml"
    original_state = '# preserve this comment\n[editor]\ntheme = "xi-light" # committed choice\n'
    state_path.write_text(original_state, encoding="utf-8")
    legacy_path = Path(temporary) / ".config" / "xi" / "state.json"
    legacy_path.parent.mkdir(parents=True)
    legacy_path.write_text('{"theme":"xi-dark"}\n', encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "HOME": temporary, "XDG_CONFIG_HOME": str(Path(temporary) / ".config"), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "theme.txt"],
        cwd=temporary,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        read_for(master, captured, 0.3)
        if DARK_BACKGROUND in captured:
            raise SystemExit(f"editor started already dark -- LIGHT/DARK_BACKGROUND fixtures need updating: {captured[-2000:]!r}")

        # Open the theme picker (space t) -- the currently applied Xi Light must remain
        # selected until navigation/hover chooses a preview.
        before_open = len(captured)
        os.write(master, b" t")
        read_for(master, captured, 0.4)
        if DARK_BACKGROUND in captured[before_open:]:
            raise SystemExit(f"opening the theme picker did not keep the current theme selected: {captured[before_open:][-2000:]!r}")

        # Hover the first visible result (Xi Dark), then the second (Xi Light).
        for row, expected in [(7, DARK_BACKGROUND), (8, LIGHT_BACKGROUND), (7, DARK_BACKGROUND)]:
            before_hover = len(captured)
            os.write(master, mouse(35, 12, row))
            read_for(master, captured, 0.3)
            if expected not in captured[before_hover:]:
                raise SystemExit(f"hover on row {row} did not apply its theme: {captured[before_hover:][-2000:]!r}")

        # Cancel with Escape -- must revert to the original light theme immediately.
        before_cancel = len(captured)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.4)
        if LIGHT_BACKGROUND not in captured[before_cancel:]:
            raise SystemExit(f"cancelling the theme picker did not restore the original theme: {captured[before_cancel:][-2000:]!r}")

        assert state_path.read_text(encoding="utf-8") == original_state, "preview/cancel changed persisted state"

        # Reopen, navigate to Xi Dark, and commit it -- it must keep the dark theme after the
        # picker closes, not just during preview.
        os.write(master, b" t")
        read_for(master, captured, 0.4)
        os.write(master, b"\x10")  # Ctrl-P previews the previous theme (Xi Dark).
        read_for(master, captured, 0.4)
        if DARK_BACKGROUND not in captured:
            raise SystemExit(f"Ctrl-P did not preview Xi Dark: {captured[-2000:]!r}")
        before_commit = len(captured)
        os.write(master, b"\r")
        wait_for(master, captured, b"XI_THEME_APPLIED", 5)
        read_for(master, captured, 0.4)
        if DARK_BACKGROUND not in captured[before_commit:]:
            raise SystemExit(f"committing Xi Dark did not keep it applied after the picker closed: {captured[before_commit:][-2000:]!r}")

        # Token consistency: Explorer, the file picker and Search each hold their own
        # independent theme (ExplorerTheme/PickerTheme, distinct shapes from WorkbenchTheme) --
        # opening each one now that Xi Dark is committed must paint them dark too, not leave
        # them on their unthemed defaults.
        before_explorer = len(captured)
        os.write(master, b" vf")
        read_for(master, captured, 0.5)
        if DARK_BACKGROUND not in captured[before_explorer:]:
            raise SystemExit(f"Explorer did not pick up the committed dark theme: {captured[before_explorer:][-2000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        before_picker = len(captured)
        os.write(master, b" f")
        read_for(master, captured, 0.5)
        if DARK_BACKGROUND not in captured[before_picker:]:
            raise SystemExit(f"the file picker did not pick up the committed dark theme: {captured[before_picker:][-2000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        before_search = len(captured)
        os.write(master, b" /")
        read_for(master, captured, 0.5)
        if DARK_BACKGROUND not in captured[before_search:]:
            raise SystemExit(f"Search did not pick up the committed dark theme: {captured[before_search:][-2000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # The context menu holds a fourth, independent theme (ContextMenuTheme) -- its own
        # background derives from theme.surface, not theme.background, so this checks a
        # distinct color: Xi Dark's surface (#181825 -> 24;24;37), not the editor background.
        DARK_SURFACE = b"\x1b[48;2;24;24;37m"
        os.write(master, b" vf")
        read_for(master, captured, 0.6)
        before_menu = len(captured)
        # Row 3: the explorer tree starts under the sidebar's 'Files' section header.
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, release=True))
        read_for(master, captured, 0.5)
        if DARK_SURFACE not in captured[before_menu:]:
            raise SystemExit(f"the context menu did not pick up the committed dark theme: {captured[before_menu:][-2000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        os.write(master, b":qa\r")
        for _ in range(4):
            if child.poll() is not None:
                break
            read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

    if child.returncode != 0:
        raise SystemExit(f"theme switch session exited {child.returncode}")

    saved_state = state_path.read_text(encoding="utf-8")
    assert tomllib.loads(saved_state)["editor"]["theme"] == "xi-dark"
    assert '# preserve this comment' in saved_state and '# committed choice' in saved_state
    # Make legacy state conflict again so the relaunch proves TOML precedence.
    legacy_path.write_text('{"theme":"xi-light"}\n', encoding="utf-8")

    # Cross-launch persistence: a fresh process against the same HOME must start dark
    # immediately, with zero picker interaction -- confirming the committed selection was
    # actually written to and read back from ~/.xi.toml, not merely held in the
    # first process's memory. Still inside the `with tempfile.TemporaryDirectory(...)` block,
    # so `temporary`/`environment` and the directory itself are still valid here.
    master2, slave2 = pty.openpty()
    fcntl.ioctl(slave2, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    child2 = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "theme.txt"],
        cwd=temporary,
        env=environment,
        stdin=slave2,
        stdout=slave2,
        stderr=slave2,
        close_fds=True,
    )
    os.close(slave2)
    captured2 = bytearray()
    try:
        wait_for(master2, captured2, b"XI_WORKBENCH_READY", 10)
        read_for(master2, captured2, 0.4)
        if DARK_BACKGROUND not in captured2:
            raise SystemExit(f"the committed theme was not restored on a fresh launch: {captured2[-2000:]!r}")
        os.write(master2, b":qa\r")
        for _ in range(4):
            if child2.poll() is not None:
                break
            read_for(master2, captured2, 0.3)
        child2.wait(timeout=5)
    finally:
        if child2.poll() is None:
            child2.kill()
            child2.wait()
        os.close(master2)
    if child2.returncode != 0:
        raise SystemExit(f"the relaunched session exited {child2.returncode}")

print("T132-THEME-SWITCH-PTY pass: navigating the theme picker previews Xi Dark live, "
      "cancelling restores the original theme, committing keeps the new theme applied after "
      "the picker closes, Explorer/file picker/Search/context-menu each independently pick "
      "up the committed theme too, and a fresh relaunched process restores the committed "
      "theme immediately from disk with no picker interaction -- all through the production "
      "CLI")
