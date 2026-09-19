#!/usr/bin/env python3
"""T094 integration gate: exercise T127 (panel pointer), T128 (terminal restoration) and
T129 (scrolling/context menu/mouse toggle) together in one production session, plus the one
combination none of those tickets tested in isolation: a real SIGTSTP/SIGCONT suspend/resume
while a splitter drag is live. T094's own evidence named that combination as an open gap
("cover focus loss/suspend while a splitter drag is active"); this fixture closes it.
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PANEL_POINTER = re.compile(rb"XI_PANEL_POINTER (\{[^\r\n]*\})")
SPLITTER = re.compile(rb"XI_WORKBENCH_SPLITTER (\{[^\r\n]*\})")
POINTER_CANCEL = re.compile(rb"XI_POINTER_CANCEL (\{[^\r\n]*\})")
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
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-6000:]!r}")


def stopped(pid: int) -> bool:
    try:
        status = (Path("/proc") / str(pid) / "status").read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    return any(line.startswith("State:") and line.split()[1] in {"T", "t"} for line in status.splitlines())


def running(pid: int) -> bool:
    try:
        status = (Path("/proc") / str(pid) / "status").read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    return any(line.startswith("State:") and line.split()[1] not in {"T", "t", "Z"} for line in status.splitlines())


def mouse(button: int, x: int, y: int, kind: str = "M") -> bytes:
    return f"\x1b[<{button};{x};{y}{kind}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-t094-integration-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    target = workspace / "zztarget.txt"
    target.write_text("INTEGRATION_TARGET_MARKER\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({
        "TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1",
        "XI_FORMATTER_COMMAND": "/bin/cat",
    })
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

        # --- T127: open Explorer, activate a row by stable id. Files starts already
        # expanded, so clicking its chevron here would collapse the inline tree instead of
        # opening it; use the same leader shortcut tests/e2e/t040-explorer-pty.py uses. ---
        os.write(master, b" vf")
        read_until(master, captured, b"XI_EXPLORER_OPEN", 5)
        read_for(master, captured, 1.0)

        # --- T129: wheel-scroll the Explorer panel (must stay scoped to the panel, not leak
        # to the editor scroll path), then right-click for a context menu and dismiss it with
        # Escape (must not leave any capture/selection state behind). ---
        before_scroll = len(captured)
        os.write(master, mouse(65, 5, 4))  # wheel-down over the panel
        read_for(master, captured, 0.3)
        if b"XI_POINTER_SCROLL" in captured[before_scroll:]:
            raise SystemExit(f"a panel wheel event leaked to the editor scroll path: {captured[before_scroll:][-2000:]!r}")

        before_menu = len(captured)
        os.write(master, mouse(2, 5, 3))
        os.write(master, mouse(2, 5, 3, "m"))
        read_for(master, captured, 0.4)
        menu_hit = next((m for m in PANEL_POINTER.finditer(captured[before_menu:]) if b'"action":"context"' in m.group(0)), None)
        if menu_hit is None:
            raise SystemExit(f"context menu did not open during the integration session: {captured[before_menu:][-3000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)

        # Activate zztarget.txt by stable id. Row 3 is the expanded workspace root (row 2 is
        # the Explorer panel's own "N items" line); probe rows from 4 (the first child) on.
        opened = False
        for row in range(4, 9):
            before = len(captured)
            os.write(master, mouse(0, 5, row))
            os.write(master, mouse(0, 5, row, "m"))
            read_for(master, captured, 0.6)
            hit = next((json.loads(m.group(1)) for m in PANEL_POINTER.finditer(captured[before:])
                        if json.loads(m.group(1)).get("panel") == "explorer" and json.loads(m.group(1)).get("action") == "activate"), None)
            if hit is not None and b"NTEGRATION_TARGET_MARKER" in captured:
                opened = True
                break
        if not opened:
            raise SystemExit(f"explorer row never activated zztarget.txt by stable id: {captured[-6000:]!r}")

        # --- T129: toggle mouse mode off via the leader keybinding, confirm a click is
        # withheld at the terminal-mode level (no marker at all), then toggle back on. ---
        os.write(master, b" m")
        read_until(master, captured, b"XI_MOUSE_MODE", 5)
        modes = [json.loads(m.group(1)) for m in MOUSE_MODE.finditer(captured)]
        if modes[-1].get("enabled") is not False:
            raise SystemExit(f"leader-key mouse toggle did not disable mouse mode: {modes!r}")
        before_disabled_click = len(captured)
        os.write(master, mouse(0, 3, 1))
        os.write(master, mouse(0, 3, 1, "m"))
        read_for(master, captured, 0.4)
        if b"XI_PANEL_POINTER" in captured[before_disabled_click:] or b"XI_EXPLORER_OPEN" in captured[before_disabled_click:]:
            raise SystemExit(f"a click was still routed while mouse mode was disabled: {captured[before_disabled_click:][-2000:]!r}")
        os.write(master, b" m")
        read_for(master, captured, 0.4)
        modes = [json.loads(m.group(1)) for m in MOUSE_MODE.finditer(captured)]
        if modes[-1].get("enabled") is not True:
            raise SystemExit(f"leader-key mouse toggle did not re-enable mouse mode: {modes!r}")

        # --- Create a split, then suspend the process (real SIGTSTP) while a splitter drag
        # is live: the capture must cancel and the process must actually stop, not hang with
        # a stuck drag; SIGCONT must then resume it fully functional. This exact combination
        # (suspend mid-drag) is the gap T094's own evidence named and no other ticket covers. ---
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":vsplit\r")
        read_until(master, captured, b"XI_WORKBENCH_SPLIT", 5)
        read_for(master, captured, 0.3)

        before_drag = len(captured)
        os.write(master, mouse(0, 75, 20))
        os.write(master, mouse(0, 85, 20))
        read_for(master, captured, 0.2)
        drag_events_before_suspend = [json.loads(m.group(1)) for m in SPLITTER.finditer(captured[before_drag:])]
        if not any(e.get("action") == "begin" for e in drag_events_before_suspend):
            raise SystemExit(f"splitter drag never began before suspend: {captured[before_drag:][-3000:]!r}")

        before_suspend = len(captured)
        os.kill(child.pid, signal.SIGTSTP)
        deadline = time.monotonic() + 5
        while not stopped(child.pid) and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if not stopped(child.pid):
            raise SystemExit("process did not stop on SIGTSTP while a splitter drag was live")
        suspend_events = [json.loads(m.group(1)) for m in SPLITTER.finditer(captured[before_suspend:])]
        suspend_cancels = [json.loads(m.group(1)) for m in POINTER_CANCEL.finditer(captured[before_suspend:])]
        if not any(e.get("action") == "cancel" for e in suspend_events):
            raise SystemExit(f"splitter drag was not cancelled by suspend: {suspend_events!r}")
        if not any(c.get("reason") == "suspend" for c in suspend_cancels):
            raise SystemExit(f"suspend did not report a pointer cancel: {suspend_cancels!r}")

        os.kill(child.pid, signal.SIGCONT)
        deadline = time.monotonic() + 5
        while not running(child.pid) and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if not running(child.pid):
            raise SystemExit("process did not resume on SIGCONT")
        read_for(master, captured, 0.4)

        # A fresh drag after resume must work cleanly (capture state wasn't left corrupted).
        before_post_resume_drag = len(captured)
        os.write(master, mouse(0, 75, 20))
        os.write(master, mouse(0, 85, 20))
        os.write(master, mouse(0, 85, 20, "m"))
        read_for(master, captured, 0.4)
        post_resume_events = [json.loads(m.group(1)) for m in SPLITTER.finditer(captured[before_post_resume_drag:])]
        if not any(e.get("action") == "begin" for e in post_resume_events) or not any(e.get("action") == "commit" for e in post_resume_events):
            raise SystemExit(f"a fresh splitter drag after resume did not begin/commit cleanly: {post_resume_events!r}")

        # --- Exact-byte preservation through the whole combined session: edit, save, quit.
        # The active view is whichever file the explorer activation above opened
        # (zztarget.txt); position deterministically at the start of line 1 before typing. ---
        os.write(master, b"gg0iQ")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":w\r")
        read_for(master, captured, 0.4)
        for expected_closed in (1, 2):
            os.write(master, b":q!\r")
            deadline = time.monotonic() + 5
            while captured.count(b"XI_WORKBENCH_VIEW_CLOSED") < expected_closed and time.monotonic() < deadline:
                read_for(master, captured, 0.05)
            if captured.count(b"XI_WORKBENCH_VIEW_CLOSED") < expected_closed:
                raise SystemExit(f"view {expected_closed} did not close: {captured[-4000:]!r}")
            read_for(master, captured, 0.2)
        if child.poll() is None:
            os.write(master, b":q!\r")
            read_for(master, captured, 1.0)
        if child.poll() is None:
            raise SystemExit(f"editor did not quit: {captured[-6000:]!r}")
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    final_text = target.read_text(encoding="utf-8")

markers = {
    "exitCode": child.returncode,
    "finalText": final_text,
}
artifact = ROOT / ".artifacts/e2e/t094-integration.json"
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.write_text(json.dumps({"schema_version": 1, "fixture": "T094-INTEGRATION-01", "markers": markers}, indent=2) + "\n", encoding="utf-8")
(artifact.parent / "t094-integration.ansi").write_bytes(captured)
if child.returncode != 0 or final_text != "QINTEGRATION_TARGET_MARKER\n":
    raise SystemExit(f"T094 integration PTY failed: {markers}\n{captured[-8000:]!r}")

print("T094-INTEGRATION-01 pass: explorer activation, panel scroll, context menu, mouse toggle, "
      "and a splitter drag cancelled by real SIGTSTP mid-drag then cleanly resumed by SIGCONT, "
      "all in one production session with exact bytes preserved")
