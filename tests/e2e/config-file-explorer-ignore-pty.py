#!/usr/bin/env python3
"""Prove the launched Files tree hides ignored paths by default and can reveal them."""
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
    root = Path(temporary) / "workspace"
    root.mkdir()
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
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
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
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
            raise SystemExit(f"default Files ignore policy did not leave only root and visible.txt: {matches!r}")
        before_toggle = len(matches)
        os.write(master, b" i")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("includeIgnored") is True and "ignored-git.txt" in item.get("visibleLabels", []) for item in matches[before_toggle:]):
                break
            read_for(master, captured, 0.05)
        else:
            raise SystemExit(f"Files Space-i did not reveal ignored paths: {matches!r}")
        before_reset = len(matches)
        os.write(master, b" i")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("includeIgnored") is False and item.get("visibleRowCount") == 2 for item in matches[before_reset:]):
                break
            read_for(master, captured, 0.05)
        else:
            raise SystemExit(f"Files Space-i did not restore the default policy: {matches!r}")
        before_hidden = len(matches)
        os.write(master, b" h")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("includeHidden") is True and ".git" in item.get("visibleLabels", []) and "ignored-git.txt" not in item.get("visibleLabels", []) for item in matches[before_hidden:]):
                break
            read_for(master, captured, 0.05)
        else:
            raise SystemExit(f"Files Space-h did not reveal dotfiles separately from ignored files: {matches!r}")
        before_both = len(matches)
        os.write(master, b" i")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if any(item.get("includeHidden") is True and item.get("includeIgnored") is True and ".git" in item.get("visibleLabels", []) and "ignored-git.txt" in item.get("visibleLabels", []) for item in matches[before_both:]):
                break
            read_for(master, captured, 0.05)
        else:
            raise SystemExit(f"Files could not reveal .git after both visibility toggles: {matches!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config file-explorer ignore PTY passed: default sources hid ignored entries, Space-i and Space-h independently revealed ignored paths and .git.")
