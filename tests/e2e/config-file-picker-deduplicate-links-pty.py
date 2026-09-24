#!/usr/bin/env python3
"""Prove editor.file-picker.deduplicate-links controls duplicate symlink entries."""
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
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"Missing picker output {marker!r}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-file-picker-dedupe-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.file-picker]\nfollow-symlinks = true\ndeduplicate-links = false\n", encoding="utf-8")
    target = root / "target"
    target.mkdir()
    (target / "linked.txt").write_text("linked\n", encoding="utf-8")
    (root / "alias").symlink_to(target, target_is_directory=True)
    source = root / "visible.txt"
    source.write_text("visible\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 8)
        os.write(master, b" f")
        wait_for(master, captured, b"Files  >", 5)
        os.write(master, b"linked.txt")
        # Equal filename matches tie-break alphabetically: alias/ first, target/ below it.
        wait_for(master, captured, b"/alias/linked.txt", 5)
        os.write(master, b"\x1b[B")
        wait_for(master, captured, b"/target/linked.txt", 5)
        if b"XI_PICKER_PREVIEW" not in captured or b"/alias/linked.txt" not in captured or b"/target/linked.txt" not in captured:
            raise SystemExit(f"deduplicate-links=false did not retain both linked entries: {captured[-4000:]!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-picker.deduplicate-links PTY passed: launched picker retained both symlink paths.")
