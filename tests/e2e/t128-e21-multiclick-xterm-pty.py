#!/usr/bin/env python3
"""E21 word/line multi-click selection through a real xterm (T128).

Word and line selection promotion (single click -> double-click promotes to word -> triple
promotes to line) is a sequence of discrete clicks at the same cell, not a continuous drag —
so, unlike the splitter/text drag case, it is not subject to the xdotool synthetic-motion
limitation found elsewhere in this investigation. This proves the production multi-click
promotion path through real X11 clicks on an actual terminal emulator, not synthetic SGR bytes.
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


def last_pointer_state(chunk: bytes) -> dict | None:
    matches = POINTER_STATE.findall(chunk)
    return json.loads(matches[-1]) if matches else None


def run() -> str:
    missing = require("Xvfb", "xterm", "xdotool")
    if missing is not None:
        return f"SKIPPED e21-multiclick-xterm: {missing!r} is not installed on this host"
    with tempfile.TemporaryDirectory(prefix="xi-t128-multiclick-") as temporary:
        workspace = Path(temporary)
        source = workspace / "words.txt"
        source.write_text("alpha beta gamma\nsecond line here\n", encoding="utf-8")
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

            # Column 51/row 2 lands on "beta" (line 0, offset 13) for this geometry and file,
            # found and confirmed empirically.
            x, y = cell(51, 2)
            subprocess.run(["xdotool", "mousemove", "--window", window_id, str(x), str(y)], env=environment, check=True)

            offset = stderr_path.stat().st_size
            subprocess.run(["xdotool", "click", "1"], env=environment, check=True)
            chunk = wait_for(stderr_path, offset, b'"kind":"click"', 5)
            state = last_pointer_state(chunk)
            if state is None or state.get("mode") != "normal":
                raise SystemExit(f"a single real click did not place a plain cursor: {state!r}")

            offset = stderr_path.stat().st_size
            subprocess.run(["xdotool", "click", "1"], env=environment, check=True)
            chunk = wait_for(stderr_path, offset, b'"kind":"word"', 5)
            state = last_pointer_state(chunk)
            if state is None or state.get("mode") != "visual" or "visual-character" not in state.get("selectionKinds", []):
                raise SystemExit(f"a real double-click did not promote to word selection: {state!r}")

            offset = stderr_path.stat().st_size
            subprocess.run(["xdotool", "click", "1"], env=environment, check=True)
            chunk = wait_for(stderr_path, offset, b'"kind":"line"', 5)
            state = last_pointer_state(chunk)
            if state is None or state.get("mode") != "visual" or "visual-line" not in state.get("selectionKinds", []):
                raise SystemExit(f"a real triple-click did not promote to line selection: {state!r}")
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
    return "PASS e21-multiclick-xterm: real click/double-click/triple-click promote through plain->word->line selection"


print(f"T128-E21-MULTICLICK-XTERM: {run()}")
