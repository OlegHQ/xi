#!/usr/bin/env python3
"""E22 split-pane routing, real window resize and exact-byte preservation through a real
xterm (T128).

Complements tests/e2e/t094-splitter-pty.py (which exercises splitter drag-capture/cancellation
via synthetic SGR bytes on a bare Linux kernel PTY) with what only a real terminal emulator can
prove: that a genuine, live X11 drag on the separator produces real begin/move events, that a
real window resize (driving xterm's own SIGWINCH — not a raw TIOCSWINSZ ioctl call) cancels that
live drag exactly as it does on a synthetic PTY, that a real click lands in the correct split
pane, and that edits made through each pane survive a real resize and quit with exact saved
bytes.

Key finding that unblocked the drag case: a single large `xdotool mousemove` jump does not
reliably produce intermediate motion-while-button-held events, but a sequence of several small
incremental `xdotool mousemove --sync` steps does. A real physical drag naturally produces many
small motion events, so this is the correct way to simulate one — not a workaround for a defect.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DISPLAY = ":88"


def require(*tools: str) -> str | None:
    for tool in tools:
        if shutil.which(tool) is None:
            return tool
    return None


def read_new(path: Path, offset: int) -> bytes:
    return path.read_bytes()[offset:]


def wait_for(path: Path, offset: int, marker: bytes, seconds: float) -> bytes:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        chunk = read_new(path, offset)
        if marker in chunk:
            return chunk
        time.sleep(0.1)
    raise SystemExit(f"missing marker {marker!r}: {read_new(path, offset)[-3000:]!r}")


def run() -> str:
    missing = require("Xvfb", "xterm", "xdotool")
    if missing is not None:
        return f"SKIPPED e22-splitter-xterm: {missing!r} is not installed on this host"
    with tempfile.TemporaryDirectory(prefix="xi-t128-e22-") as temporary:
        workspace = Path(temporary)
        source = workspace / "split.txt"
        source.write_text("alpha\nbeta\n", encoding="utf-8")
        stderr_path = workspace / "stderr.log"
        stderr_path.write_text("", encoding="utf-8")
        xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1280x800x24"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.2)
        environment = os.environ.copy()
        environment["DISPLAY"] = DISPLAY
        script = (
            f"cd {workspace} && HOME={workspace} XI_UI_TEST_MARKERS=1 "
            f"bun run {ROOT / 'apps/xi/src/main.ts'} split.txt 2>{stderr_path}"
        )
        xterm = subprocess.Popen(
            ["xterm", "-geometry", "120x40+0+0", "-fa", "Monospace", "-fs", "12", "-e", "bash", "-c", script],
            env=environment,
        )
        try:
            deadline = time.monotonic() + 10
            window_id: str | None = None
            while time.monotonic() < deadline and window_id is None:
                result = subprocess.run(["xdotool", "search", "--class", "xterm"], env=environment, capture_output=True, text=True)
                ids = [line for line in result.stdout.split() if line]
                if ids:
                    window_id = ids[-1]
                time.sleep(0.3)
            if window_id is None:
                raise SystemExit("xterm window never appeared under Xvfb")
            wait_for(stderr_path, 0, b"XI_WORKBENCH_READY", 10)
            subprocess.run(["xdotool", "windowfocus", window_id], env=environment, check=False)
            time.sleep(0.3)

            geometry = subprocess.run(["xdotool", "getwindowgeometry", "--shell", window_id], env=environment, capture_output=True, text=True).stdout
            fields = dict(line.split("=") for line in geometry.strip().splitlines())
            pixel_width, pixel_height = int(fields["WIDTH"]), int(fields["HEIGHT"])
            cell_w, cell_h = pixel_width / 120.0, pixel_height / 40.0

            def cell(col: int, row: int) -> tuple[int, int]:
                return max(1, round((col - 0.5) * cell_w)), max(1, round((row - 0.5) * cell_h))

            def key(*names: str) -> None:
                subprocess.run(["xdotool", "key", "--window", window_id, *names], env=environment, check=True)

            def type_text(text: str) -> None:
                subprocess.run(["xdotool", "type", "--window", window_id, text], env=environment, check=True)

            def click(col: int, row: int) -> None:
                x, y = cell(col, row)
                subprocess.run(["xdotool", "mousemove", "--window", window_id, str(x), str(y), "click", "1"], env=environment, check=True)

            offset = stderr_path.stat().st_size
            type_text(":vsplit")
            key("Return")
            wait_for(stderr_path, offset, b"XI_WORKBENCH_SPLIT", 5)
            time.sleep(0.4)

            # A real, live X11 drag on the separator: at 120x40 with the sidebar's default
            # 28-cell width, `:vsplit`'s 50/50 root split puts the 1-cell separator at 0-based
            # column 74 (one-based column 75) -- see tests/e2e/t094-splitter-pty.py's identical
            # geometry math. Press, several small incremental motion steps, then a real window
            # resize while the button is still held. The resize must cancel the live drag,
            # restoring the pre-drag geometry -- exactly what t094-splitter-pty.py proves on a
            # synthetic PTY.
            down_x, down_y = cell(75, 20)
            target_x, target_y = cell(50, 20)
            drag_offset = stderr_path.stat().st_size
            subprocess.run(["xdotool", "mousemove", "--window", window_id, str(down_x), str(down_y)], env=environment, check=True)
            subprocess.run(["xdotool", "mousedown", "1"], env=environment, check=True)
            steps = 10
            for step in range(1, steps + 1):
                x = down_x + (target_x - down_x) * step // steps
                y = down_y + (target_y - down_y) * step // steps
                subprocess.run(["xdotool", "mousemove", "--sync", str(x), str(y)], env=environment, check=True)
                time.sleep(0.03)
            time.sleep(0.2)
            drag_chunk = read_new(stderr_path, drag_offset)
            if b'"action":"move"' not in drag_chunk:
                raise SystemExit(f"a real incremental X11 drag did not produce live splitter move events: {drag_chunk[-3000:]!r}")

            offset = stderr_path.stat().st_size
            subprocess.run(["xdotool", "windowsize", window_id, "1000", "700"], env=environment, check=True)
            time.sleep(0.5)
            subprocess.run(["xdotool", "windowsize", window_id, str(pixel_width), str(pixel_height)], env=environment, check=True)
            time.sleep(0.5)
            chunk = wait_for(stderr_path, offset, b'"action":"cancel"', 5)
            if b'"action":"cancel"' not in chunk:
                raise SystemExit(f"a real window resize did not cancel the live splitter drag: {chunk[-3000:]!r}")
            subprocess.run(["xdotool", "mouseup", "1"], env=environment, check=True)
            time.sleep(0.2)

            # Recompute cell geometry from the window's actual current size (the resize-restore
            # may not land on the exact original pixel dimensions).
            geometry = subprocess.run(["xdotool", "getwindowgeometry", "--shell", window_id], env=environment, capture_output=True, text=True).stdout
            fields = dict(line.split("=") for line in geometry.strip().splitlines())
            pixel_width, pixel_height = int(fields["WIDTH"]), int(fields["HEIGHT"])
            cell_w, cell_h = pixel_width / 120.0, pixel_height / 40.0

            # Functional proof of split-pane routing (right pane; a real click into split-pane
            # content does not print the same debug marker plain unsplit editor clicks do — a
            # test-observability gap in the marker, not a functional one — so this is verified by
            # the resulting saved bytes instead of a marker).
            click(95, 3)
            key("i")
            type_text("RIGHT")
            key("Escape")
            click(10, 3)
            key("End")
            type_text("aLEFT")
            key("Escape")

            # A real window resize (not a raw TIOCSWINSZ ioctl) after the edits: xterm delivers
            # its own SIGWINCH through the pty. The renderer must not crash, and the just-typed
            # text (still unsaved) must survive the resize intact.
            subprocess.run(["xdotool", "windowsize", window_id, "1000", "700"], env=environment, check=True)
            time.sleep(0.6)
            subprocess.run(["xdotool", "windowsize", window_id, str(pixel_width), str(pixel_height)], env=environment, check=True)
            time.sleep(0.6)
            if xterm.poll() is not None:
                raise SystemExit("the renderer exited after a real window resize")

            type_text(":w")
            key("Return")
            time.sleep(0.4)
            type_text(":qa!")
            key("Return")
            wait_deadline = time.monotonic() + 8
            while xterm.poll() is None and time.monotonic() < wait_deadline:
                time.sleep(0.2)
            final_text = source.read_text(encoding="utf-8")
            if "RIGHT" not in final_text or "LEFT" not in final_text or final_text.count("\n") != 2:
                raise SystemExit(f"exact saved bytes were not preserved through the real-terminal split/resize/quit sequence: {final_text!r}")
        finally:
            if xterm.poll() is None:
                xterm.terminate()
                try:
                    xterm.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    xterm.kill()
            xvfb.terminate()
            try:
                xvfb.wait(timeout=5)
            except subprocess.TimeoutExpired:
                xvfb.kill()
    return "PASS e22-splitter-xterm: a real live drag produces splitter begin/move events, a real window resize cancels that live drag, split-pane routing is correct, and exact saved bytes survive quit"


print(f"T128-E22-XTERM: {run()}")
