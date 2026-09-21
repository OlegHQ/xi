#!/usr/bin/env python3
"""Prove the launched Explorer applies Helix's five ignore-source toggles."""
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


with tempfile.TemporaryDirectory(prefix="xi-file-explorer-ignore-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[editor.file-explorer]\n"
        "hidden = true\n"
        "parents = true\n"
        "ignore = true\n"
        "git-ignore = true\n"
        "git-global = true\n"
        "git-exclude = true\n",
        encoding="utf-8",
    )
    (root / "visible.txt").write_text("visible\n", encoding="utf-8")
    (root / "ignored-ignore.txt").write_text("ignored\n", encoding="utf-8")
    (root / "ignored-git.txt").write_text("ignored\n", encoding="utf-8")
    (root / "ignored-global.txt").write_text("ignored\n", encoding="utf-8")
    (root / "ignored-exclude.txt").write_text("ignored\n", encoding="utf-8")
    (root / "ignored-parent.txt").write_text("ignored\n", encoding="utf-8")
    (root / ".ignore").write_text("ignored-ignore.txt\n", encoding="utf-8")
    (root / ".gitignore").write_text("ignored-git.txt\n", encoding="utf-8")
    (root / ".git" / "info").mkdir(parents=True)
    (root / ".git" / "info" / "exclude").write_text("ignored-exclude.txt\n", encoding="utf-8")
    (root.parent / ".ignore").write_text("ignored-parent.txt\n", encoding="utf-8")
    (root / ".config" / "git").mkdir(parents=True)
    (root / ".config" / "git" / "ignore").write_text("ignored-global.txt\n", encoding="utf-8")

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
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("state") == "ready" and item.get("visibleRowCount") == 2 for item in matches):
                break
            read_for(master, captured, 0.05)
        matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
        if not any(item.get("state") == "ready" and item.get("includeHidden") is False and item.get("visibleRowCount") == 2 for item in matches):
            raise SystemExit(f"file-explorer ignore sources did not leave only root and visible.txt: {matches!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-explorer ignore PTY passed: parent, .ignore, .gitignore, global and git-exclude rules hid ignored entries.")
