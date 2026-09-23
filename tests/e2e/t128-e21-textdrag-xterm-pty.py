#!/usr/bin/env python3
"""E21 text-selection drag-to-extend through a real xterm (T128).

Uses the same technique found for the splitter live drag: a real physical drag is several
small incremental motion events, not one large `xdotool mousemove` jump, so the drag is
driven with a sequence of `xdotool mousemove --sync` steps. Proves a real X11 mouse-down on
a character followed by real incremental motion extends a character-visual selection through
the actual production pointer path — completing real-terminal coverage of drag-to-extend
alongside the already-covered splitter drag (t128-e22-splitter-xterm-pty.py).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from xvfb_fixture import start_xvfb

ROOT = Path(__file__).resolve().parents[2]
POINTER_STATE = re.compile(rb"XI_POINTER_STATE (\{[^\r\n]*\})")


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


def pointer_states(chunk: bytes) -> list[dict]:
    return [json.loads(match.group(1)) for match in POINTER_STATE.finditer(chunk)]


def run() -> str:
    missing = require("Xvfb", "xterm", "xdotool")
    if missing is not None:
        return f"SKIPPED e21-textdrag-xterm: {missing!r} is not installed on this host"
    with tempfile.TemporaryDirectory(prefix="xi-t128-textdrag-") as temporary:
        workspace = Path(temporary)
        source = workspace / "words.txt"
        source.write_text("alpha beta gamma delta epsilon\nsecond line here\n", encoding="utf-8")
        stderr_path = workspace / "stderr.log"
        stderr_path.write_text("", encoding="utf-8")
        xvfb, display = start_xvfb()
        environment = os.environ.copy()
        environment["DISPLAY"] = display
        script = (
            f"cd {workspace} && HOME={workspace} XI_UI_TEST_MARKERS=1 "
            f"bun run {ROOT / 'apps/xi/src/main.ts'} words.txt 2>{stderr_path}"
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

            # Column 51/row 2 lands on offset 13 ("beta"); column 65/row 2 on offset ~27
            # ("epsilon"), found and confirmed empirically for this geometry and file.
            down_x, down_y = cell(51, 2)
            target_x, target_y = cell(65, 2)
            subprocess.run(["xdotool", "mousemove", "--window", window_id, str(down_x), str(down_y)], env=environment, check=True)
            subprocess.run(["xdotool", "mousedown", "1"], env=environment, check=True)
            offset = stderr_path.stat().st_size
            steps = 10
            for step in range(1, steps + 1):
                x = down_x + (target_x - down_x) * step // steps
                y = down_y + (target_y - down_y) * step // steps
                subprocess.run(["xdotool", "mousemove", "--sync", str(x), str(y)], env=environment, check=True)
                time.sleep(0.03)
            time.sleep(0.2)
            chunk = read_new(stderr_path, offset)
            drags = [state for state in pointer_states(chunk) if state.get("kind") == "drag"]
            if not drags:
                raise SystemExit(f"a real incremental X11 drag did not produce live text-drag events: {chunk[-3000:]!r}")
            if any(state.get("mode") != "visual" or "visual-character" not in state.get("selectionKinds", []) for state in drags):
                raise SystemExit(f"a real text drag did not extend a character-visual selection: {drags!r}")
            offsets = [state["target"]["offset"] for state in drags]
            if offsets != sorted(offsets) or offsets[-1] <= offsets[0]:
                raise SystemExit(f"the real drag's selection did not monotonically extend forward: {offsets!r}")
            subprocess.run(["xdotool", "mouseup", "1"], env=environment, check=True)
            time.sleep(0.2)
            subprocess.run(["xdotool", "key", "--window", window_id, "Escape"], env=environment, check=True)
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
    return "PASS e21-textdrag-xterm: a real incremental X11 drag extends a character-visual selection through the production pointer path"


print(f"T128-E21-TEXTDRAG-XTERM: {run()}")
