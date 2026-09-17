#!/usr/bin/env python3
"""Capture real production workbench journeys (T045's own "visual review" step) through a
genuine xterm window running the actual launched CLI (apps/xi/src/main.ts) -- not a spike
harness. Unlike T063/T087's own screenshot scripts (which drive a synthetic component
directly), this launches the real production process the same way tests/e2e/t128-*-xterm-*
already do, under Xvfb.
"""
from __future__ import annotations

import fcntl
import os
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / '.artifacts' / 'ui' / 't045-screenshots'


def require(*names: str) -> str | None:
    for name in names:
        if shutil.which(name) is None:
            return name
    return None


def wait_for_marker(stderr_path: Path, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if stderr_path.exists() and marker in stderr_path.read_bytes():
            return
        time.sleep(0.1)
    raise SystemExit(f"missing marker {marker!r} in {stderr_path}")


def capture(name: str, geometry: str, workspace: Path, source: str, keys: list[tuple[str | None, float]]) -> dict[str, object]:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    stderr_path = ARTIFACTS / f'{name}.stderr'
    stderr_path.write_text('', encoding='utf-8')
    script = (
        f"cd {workspace} && HOME={workspace} XI_UI_TEST_MARKERS=1 "
        f"bun run {ROOT / 'apps/xi/src/main.ts'} {source} 2>{stderr_path}"
    )
    title = f'Xi-T045-{name}'
    xterm = subprocess.Popen(
        ["xterm", "-title", title, "-geometry", geometry, "-fa", "Monospace", "-fs", "12", "-e", "bash", "-c", script],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_marker(stderr_path, b"XI_WORKBENCH_READY", 10)
        window_id: str | None = None
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            result = subprocess.run(["xdotool", "search", "--name", title], capture_output=True, text=True)
            ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            if ids:
                window_id = ids[-1]
                break
            time.sleep(0.1)
        if window_id is None:
            raise RuntimeError(f"xterm window did not appear: {title}")
        subprocess.run(["xdotool", "windowfocus", window_id], check=False)
        time.sleep(0.5)
        for key, settle in keys:
            if key is None:
                time.sleep(settle)
                continue
            if key.startswith("click:"):
                _, col, row, button = key.split(":")
                cols, rows = (int(part) for part in geometry.split("+")[0].split("x"))
                wgeometry = subprocess.run(["xdotool", "getwindowgeometry", "--shell", window_id], capture_output=True, text=True).stdout
                wfields = dict(line.split("=") for line in wgeometry.strip().splitlines())
                cell_w, cell_h = int(wfields["WIDTH"]) / cols, int(wfields["HEIGHT"]) / rows
                x = max(1, round((int(col) - 0.5) * cell_w))
                y = max(1, round((int(row) - 0.5) * cell_h))
                subprocess.run(["xdotool", "mousemove", "--window", window_id, str(x), str(y)], check=True)
                subprocess.run(["xdotool", "click", button], check=True)
            else:
                subprocess.run(["xdotool", "key", "--window", window_id, key], check=True)
            time.sleep(settle)
        image_path = ARTIFACTS / f'{name}.png'
        subprocess.run(["import", "-window", window_id, str(image_path)], check=True)
        return {"name": name, "path": str(image_path)}
    finally:
        subprocess.run(["pkill", "-f", f"apps/xi/src/main.ts {source}"], check=False)
        if xterm.poll() is None:
            xterm.terminate()
            try:
                xterm.wait(timeout=5)
            except subprocess.TimeoutExpired:
                xterm.kill()


def main() -> int:
    missing = require("Xvfb", "xterm", "xdotool", "import", "bun")
    if missing is not None:
        print(f"SKIPPED: {missing!r} is not installed on this host")
        return 0
    with tempfile.TemporaryDirectory(prefix="xi-t045-screenshot-") as temporary:
        workspace = Path(temporary)
        (workspace / "src").mkdir()
        (workspace / "src" / "nested.ts").write_text("export const value = Math.sqrt(4);\n", encoding="utf-8")
        (workspace / "package.json").write_text("{}\n", encoding="utf-8")
        (workspace / "main.ts").write_text(
            "function greet(name: string): string {\n  return `hello ${name}`;\n}\n\ngreet('world');\n",
            encoding="utf-8",
        )
        captures = [
            capture("explorer-split", "120x40+0+0", workspace, "main.ts", [
                ("space", 0.3), ("v", 0.2), ("f", 0.8),
            ]),
            capture("search-replace", "120x40+0+0", workspace, "main.ts", [
                ("space", 0.3), ("slash", 0.3),
            ] + [(f"{c}", 0.05) for c in "greet"] + [
                (None, 0.5),
                # Leader keys only reach the leader dispatcher while no panel's own
                # keypress handler has focus (see docs/evidence/T045.md's E02 addendum) --
                # close the search panel first so the next space is seen by the leader
                # system, which reopens search fresh (query preserved) and enters replace.
                ("Escape", 0.3), ("space", 0.2), ("r", 0.5),
            ] + [(f"{c}", 0.05) for c in "hola"] + [
                (None, 0.5),
            ]),
            capture("context-menu-narrow", "60x20+0+0", workspace, "main.ts", [
                # The context menu is only wired for panel items (Explorer/picker/search/
                # problems rows), not bare editor text -- open Explorer first, then
                # right-click on its "main.ts" row.
                ("space", 0.2), ("v", 0.2), ("f", 0.6),
                ("click:8:4:3", 0.6),
            ]),
            capture("completion-popup", "120x40+0+0", workspace, "src/nested.ts", [
                ("dollar", 0.2), ("a", 0.3), ("ctrl+space", 1.5),
            ]),
        ]
    for item in captures:
        print(item)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
