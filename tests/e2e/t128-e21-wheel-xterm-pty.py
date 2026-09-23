#!/usr/bin/env python3
"""E21 editor wheel scroll through a real xterm (T128).

Unlike a splitter/text drag (mousedown -> mousemove -> mouseup, which needs xdotool to
synthesize intermediate "motion while button held" events — found in this same investigation
to not reliably reach the app through xterm's SGR encoding), a wheel event is a single
discrete button-4/5 press with no motion requirement, so it is not subject to that limitation.
This proves real mouse-wheel scrolling in the editor (not a panel) through an actual terminal
emulator: the production XI_POINTER_SCROLL path, and the resulting visible viewport change.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from xvfb_fixture import start_xvfb

ROOT = Path(__file__).resolve().parents[2]


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
        return f"SKIPPED e21-wheel-xterm: {missing!r} is not installed on this host"
    with tempfile.TemporaryDirectory(prefix="xi-t128-e21-") as temporary:
        workspace = Path(temporary)
        source = workspace / "long.txt"
        source.write_text("\n".join(f"line {index:03d}" for index in range(200)) + "\n", encoding="utf-8")
        stderr_path = workspace / "stderr.log"
        stderr_path.write_text("", encoding="utf-8")
        xvfb, display = start_xvfb()
        environment = os.environ.copy()
        environment["DISPLAY"] = display
        script = (
            f"cd {workspace} && HOME={workspace} XI_UI_TEST_MARKERS=1 "
            f"bun run {ROOT / 'apps/xi/src/main.ts'} long.txt 2>{stderr_path}"
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

            x, y = cell(60, 20)
            subprocess.run(["xdotool", "mousemove", "--window", window_id, str(x), str(y)], env=environment, check=True)

            def last_scroll_top(chunk: bytes) -> int | None:
                import json as _json
                import re as _re
                matches = _re.findall(rb"XI_POINTER_SCROLL (\{[^\r\n]*\})", chunk)
                if not matches:
                    return None
                return _json.loads(matches[-1])["scrollTop"]

            # Real wheel-down (button 5) events through the actual terminal must monotonically
            # increase scrollTop — the production viewport actually moved, not just the marker.
            offset = stderr_path.stat().st_size
            for _ in range(30):
                subprocess.run(["xdotool", "click", "5"], env=environment, check=True)
            chunk = wait_for(stderr_path, offset, b'"delta":1', 5)
            time.sleep(0.2)
            scroll_top_after_down = last_scroll_top(read_new(stderr_path, offset))
            if not scroll_top_after_down or scroll_top_after_down < 20:
                raise SystemExit(f"real wheel-down did not move the editor viewport far enough: scrollTop={scroll_top_after_down!r} chunk={chunk[-1500:]!r}")

            # Real wheel-up (button 4) back to the top (scrollTop clamped at 0).
            offset = stderr_path.stat().st_size
            for _ in range(40):
                subprocess.run(["xdotool", "click", "4"], env=environment, check=True)
            wait_for(stderr_path, offset, b'"delta":-1', 5)
            time.sleep(0.2)
            scroll_top_after_up = last_scroll_top(read_new(stderr_path, offset))
            if scroll_top_after_up != 0:
                raise SystemExit(f"real wheel-up did not scroll the editor viewport back to the top: scrollTop={scroll_top_after_up!r}")
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
    return "PASS e21-wheel-xterm: real mouse-wheel scroll moves and restores the editor viewport through an actual terminal"


print(f"T128-E21-XTERM: {run()}")
