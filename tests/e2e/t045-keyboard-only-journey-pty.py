#!/usr/bin/env python3
"""T045: a complete workbench journey using only the keyboard, through the production CLI.
T045's own acceptance requires "Keyboard journeys require no mouse" -- this had strong
implicit evidence (essentially every fixture in tests/e2e/ this ticket's own work added is
itself keyboard-driven) but no single, explicit, dedicated demonstration that a realistic
end-to-end session -- editing, dot-repeat, search, Explorer file management, the picker, and
theme switching -- never requires a single mouse event. This fixture is that dedicated
demonstration: not one byte of this script is a mouse escape sequence (no `\\x1b[<...M`/`m`
SGR mouse report anywhere in the source), and it deliberately exercises one representative
action from each major subsystem this session touched.
"""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
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


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


DARK_BACKGROUND = b"\x1b[48;2;30;30;46m"

with tempfile.TemporaryDirectory(prefix="xi-t045-keyboard-only-") as temporary:
    workspace = Path(temporary)
    (workspace / "journey.txt").write_text("first line\nsecond line\n", encoding="utf-8")
    (workspace / "other.txt").write_text("needle target\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "journey.txt"],
        cwd=workspace,
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

        # 1. Ordinary Normal-mode navigation and Insert-mode editing.
        os.write(master, b"jA")
        read_for(master, captured, 0.2)
        os.write(master, b" edited")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # 2. Dot-repeat (T130): replay that exact "append ' edited'" insert on the first line.
        os.write(master, b"gg")
        read_for(master, captured, 0.2)
        os.write(master, b"$")
        read_for(master, captured, 0.2)
        os.write(master, b".")
        read_for(master, captured, 0.3)

        # 3. Workspace search (keyboard-triggered leader sequence), then close it.
        os.write(master, b" /")
        wait_for(master, captured, b"XI_SEARCH_OPEN", 5)
        os.write(master, b"needle")
        read_for(master, captured, 0.5)
        # Esc first leaves insert mode for normal mode, a second Esc closes the panel.
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # 4. Explorer file management (T131): rename other.txt via keyboard draft/apply.
        os.write(master, b" vf")
        wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, 0.5)
        os.write(master, b"jj")
        read_for(master, captured, 0.4)
        os.write(master, b"r")
        read_for(master, captured, 0.2)
        for _ in range(20):
            os.write(master, b"\x7f")
        read_for(master, captured, 0.2)
        os.write(master, b"renamed-by-keyboard.txt")
        read_for(master, captured, 0.2)
        os.write(master, b"\r")
        wait_for(master, captured, b"XI_EXPLORER_RENAME_APPLIED", 5)
        read_for(master, captured, 0.3)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)

        # 5. Theme switching (T132): commit Xi Dark via the keyboard-driven picker.
        os.write(master, b" t")
        read_for(master, captured, 0.4)
        before_theme = len(captured)
        os.write(master, b"\r")
        wait_for(master, captured, b"XI_THEME_APPLIED", 5)
        read_for(master, captured, 0.3)
        if DARK_BACKGROUND not in captured[before_theme:]:
            raise SystemExit(f"keyboard-only theme commit did not repaint: {captured[before_theme:][-2000:]!r}")

        # 6. Save and quit, all via the keyboard-driven Ex command line.
        os.write(master, b":wq\r")
        for _ in range(5):
            if child.poll() is not None:
                break
            read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    final_text = (workspace / "journey.txt").read_text(encoding="utf-8")
    renamed_exists = (workspace / "renamed-by-keyboard.txt").exists()

if child.returncode != 0:
    raise SystemExit(f"keyboard-only journey session exited {child.returncode}")
if final_text != "first line edited\nsecond line edited\n":
    raise SystemExit(f"the keyboard-only edit+dot-repeat sequence did not produce the expected text: {final_text!r}")
if not renamed_exists:
    raise SystemExit("the keyboard-only Explorer rename did not apply")
print("T045-KEYBOARD-ONLY-JOURNEY-PTY pass: a complete workbench journey -- navigate, edit, "
      "dot-repeat, search, Explorer rename, theme switch, save and quit -- completed correctly "
      "using only the keyboard, with zero mouse events sent at any point, through the "
      "production CLI")
