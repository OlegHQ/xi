#!/usr/bin/env python3
"""Prove editor.file-explorer.follow-symlinks changes launched Explorer traversal."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REFRESH = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def refreshes(captured: bytearray) -> list[dict]:
    return [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]


def wait_for(master: int, captured: bytearray, predicate, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        matches = [item for item in refreshes(captured) if predicate(item)]
        if matches:
            return matches[-1]
        read_for(master, captured, 0.05)
    raise SystemExit(f"no matching Explorer refresh: {refreshes(captured)!r}")


with tempfile.TemporaryDirectory(prefix="xi-file-explorer-symlinks-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor.file-explorer]\nhidden = true\nfollow-symlinks = true\n", encoding="utf-8")
    (root / "target").mkdir()
    (root / "target" / "child.txt").write_text("child\n", encoding="utf-8")
    try:
        (root / "link").symlink_to("target", target_is_directory=True)
    except OSError as error:
        raise SystemExit(f"cannot create symlink fixture: {error}")
    (root / "visible.txt").write_text("visible\n", encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "visible.txt"],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start: {captured[-4000:]!r}")

        os.write(master, b" vf")
        wait_for(master, captured, lambda item: item.get("state") == "ready" and item.get("followSymlinks") is True, 8)
        os.write(master, b"/link")
        wait_for(master, captured, lambda item: item.get("filter") == "link", 5)
        os.write(master, b"\x1b")
        wait_for(master, captured, lambda item: item.get("filter") == "" and item.get("selectedPath") == "", 5)
        os.write(master, b"jj")
        cleared = wait_for(master, captured, lambda item: item.get("filter") == "" and item.get("selectedPath") == "link", 5)
        before_expand = cleared.get("visibleRowCount")
        if not isinstance(before_expand, int):
            raise SystemExit(f"Explorer did not report visible rows before symlink expansion: {cleared!r}")
        os.write(master, b"l")
        expanded = wait_for(master, captured, lambda item: item.get("followSymlinks") is True and item.get("state") == "ready" and isinstance(item.get("visibleRowCount"), int) and item["visibleRowCount"] > before_expand, 8)
        if expanded.get("visibleRowCount", 0) <= before_expand:
            raise SystemExit(f"follow-symlinks=true did not expand the link: {expanded!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-explorer.follow-symlinks PTY passed: follow-symlinks=true traversed a launched Explorer symlink.")
