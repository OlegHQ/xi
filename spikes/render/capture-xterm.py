#!/usr/bin/env python3
"""Capture the real CLI render spike in xterm running under Xvfb."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


ROOT = Path.cwd()
ARTIFACTS = ROOT / ".artifacts" / "t002" / "terminal"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    args = parser.parse_args()
    if args.width < 40 or args.height < 10:
        parser.error("terminal dimensions must be at least 40x10")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 60:
        parser.error("timeout-seconds must be in (0, 60]")
    for command in ("xterm", "xdotool", "import"):
        if shutil.which(command) is None:
            parser.error(f"missing screenshot dependency: {command}")
    return args


def read_json(path: Path) -> dict[str, object]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected JSON object in {path}")
    return value


def main() -> int:
    args = parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    ready_path = ARTIFACTS / "visual-ready.json"
    status_path = ARTIFACTS / "visual-status.json"
    screenshot_path = ARTIFACTS / "screenshots" / f"{args.width}x{args.height}.png"
    screenshot_path.parent.mkdir(parents=True, exist_ok=True)
    for stale_path in (ready_path, status_path, screenshot_path):
        stale_path.unlink(missing_ok=True)

    title = f"Xi T002 {args.width}x{args.height}"
    command = [
        "xterm",
        "-T", title,
        "-geometry", f"{args.width}x{args.height}+0+0",
        "-fa", "DejaVu Sans Mono",
        "-fs", "9",
        "-e", "bun", "run", "spikes/render/terminal-probe.ts", "visual",
    ]
    child_env = os.environ.copy()
    child_env["TERM"] = "xterm-256color"
    child_env["COLORTERM"] = "truecolor"
    terminal = subprocess.Popen(command, cwd=ROOT, env=child_env)
    try:
        search = subprocess.run(
            ["xdotool", "search", "--sync", "--onlyvisible", "--name", title],
            check=True,
            capture_output=True,
            text=True,
            timeout=args.timeout_seconds,
        )
        window_id = search.stdout.splitlines()[0].strip()

        deadline = time.monotonic() + args.timeout_seconds
        while time.monotonic() < deadline and not ready_path.exists():
            if terminal.poll() is not None:
                raise RuntimeError(f"xterm exited before rendering, status={terminal.returncode}")
            time.sleep(0.05)
        if not ready_path.exists():
            raise TimeoutError("OpenTUI did not render its first xterm frame")

        ready = read_json(ready_path)
        if ready.get("width") != args.width or ready.get("height") != args.height:
            raise RuntimeError(f"xterm PTY size mismatch: requested {args.width}x{args.height}, got {ready}")
        time.sleep(0.25)
        subprocess.run(["import", "-window", window_id, str(screenshot_path)], check=True, timeout=args.timeout_seconds)
        if not screenshot_path.is_file() or screenshot_path.stat().st_size == 0:
            raise RuntimeError(f"xterm screenshot was not written: {screenshot_path}")

        subprocess.run(["xdotool", "windowfocus", "--sync", window_id], check=True, timeout=5)
        subprocess.run(["xdotool", "key", "q"], check=True, timeout=5)
        terminal.wait(timeout=args.timeout_seconds)
        if terminal.returncode != 0:
            raise RuntimeError(f"terminal probe exited with status {terminal.returncode}")
        if not status_path.exists():
            raise RuntimeError("terminal probe did not record its shutdown state")
        status = read_json(status_path)
        if status.get("terminal", {}).get("rawModeRestored") is not True:
            raise RuntimeError(f"xterm shutdown did not restore raw input mode: {status}")

        metadata_path = ARTIFACTS / f"screenshot-{args.width}x{args.height}.json"
        metadata_path.write_text(json.dumps({
            "terminal": "xterm",
            "width": args.width,
            "height": args.height,
            "font": "DejaVu Sans Mono 9pt",
            "screenshot": str(screenshot_path),
            "ready": ready,
            "shutdown": status,
        }, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({
            "terminal": "xterm",
            "size": f"{args.width}x{args.height}",
            "screenshot": str(screenshot_path),
            "bytes": screenshot_path.stat().st_size,
            "shutdownRestoredRawMode": status["terminal"]["rawModeRestored"],
        }, indent=2))
        return 0
    finally:
        if terminal.poll() is None:
            terminal.terminate()
            try:
                terminal.wait(timeout=3)
            except subprocess.TimeoutExpired:
                terminal.kill()
                terminal.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
