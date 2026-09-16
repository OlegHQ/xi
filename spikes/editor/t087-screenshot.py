#!/usr/bin/env python3
"""Capture T087's production workbench painter in a real xterm under Xvfb."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / ".artifacts" / "ui" / "t087-screenshots"


def capture(name: str, geometry: str, color_mode: str, ascii_mode: bool = False) -> dict[str, object]:
    title = f"Xi-T087-{name}"
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    stderr_path = ARTIFACTS / f"{name}.stderr"
    command = f"cd {quote(str(ROOT))} && XI_UI_TEST_MARKERS=1 XI_T087_COLOR_MODE={quote(color_mode)} XI_T087_ASCII={'1' if ascii_mode else '0'} bun run spikes/editor/t087-visual.ts 2>{quote(str(stderr_path))}"
    child = subprocess.Popen(["xterm", "-title", title, "-geometry", geometry, "-fa", "Noto Mono", "-fs", "12", "-e", "bash", "-lc", command], env=os.environ.copy(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    window_id = None
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            result = subprocess.run(["xdotool", "search", "--name", title], check=False, capture_output=True, text=True)
            ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            if ids:
                window_id = ids[-1]
                break
            time.sleep(0.05)
        if window_id is None:
            raise RuntimeError(f"xterm window did not appear: {title}")
        time.sleep(1.0)
        image_path = ARTIFACTS / f"{name}.png"
        subprocess.run(["import", "-window", window_id, str(image_path)], check=True)
        return {"name": name, "geometry": geometry, "colorMode": color_mode, "ascii": ascii_mode, "window": window_id, "path": str(image_path)}
    finally:
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=3)


def quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def main() -> None:
    captures = [
        capture("truecolor-120x40", "120x40", "truecolor"),
        capture("ansi256-120x40", "120x40", "ansi256"),
        capture("no-color-120x40", "120x40", "no-color"),
        capture("no-color-60x18", "60x18", "no-color", True),
    ]
    result = {"captures": captures, "xterm": subprocess.check_output(["xterm", "-version"], text=True, stderr=subprocess.STDOUT).strip()}
    (ARTIFACTS / "index.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"T087 real-terminal screenshots passed: {len(captures)} captures")


if __name__ == "__main__":
    main()
