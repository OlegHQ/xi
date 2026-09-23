#!/usr/bin/env python3
"""Prove all enabled Helix file-picker ignore sources affect the production picker."""
from __future__ import annotations

import os
import pty
import re
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


with tempfile.TemporaryDirectory(prefix="xi-file-picker-ignore-pty-") as outer:
    parent = Path(outer)
    root = parent / "workspace"
    root.mkdir()
    home = parent / "home"
    (home / ".config" / "xi").mkdir(parents=True)
    (home / ".config" / "git").mkdir(parents=True)
    (home / ".config" / "git" / "ignore").write_text("global.txt\n", encoding="utf-8")
    (home / ".config" / "xi" / "config.toml").write_text(
        "schema-version = 1\n[editor.file-picker]\nparents = true\nignore = true\ngit-ignore = true\ngit-global = true\ngit-exclude = true\n",
        encoding="utf-8",
    )
    (parent / ".ignore").write_text("parent.txt\n", encoding="utf-8")
    (root / ".git" / "info").mkdir(parents=True)
    (root / ".git" / "info" / "exclude").write_text("exclude.txt\n", encoding="utf-8")
    (root / ".ignore").write_text("ignored.txt\n", encoding="utf-8")
    (root / ".gitignore").write_text("git.txt\n", encoding="utf-8")
    for name in ("visible.txt", "ignored.txt", "git.txt", "global.txt", "exclude.txt", "parent.txt"):
        (root / name).write_text(name + "\n", encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(root / "visible.txt")],
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
        read_for(master, captured, 8)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        os.write(master, b" f")
        read_for(master, captured, 1)
        if b"Files  >" not in captured:
            raise SystemExit(f"file picker did not open: {captured[-4000:]!r}")
        os.write(master, b"ignored.txt")
        read_for(master, captured, 0.4)
        if re.search(rb"XI_PICKER_PREVIEW \{[^\r\n]*ignored\.txt", captured):
            raise SystemExit("ignored.txt was previewed despite editor.file-picker.ignore=true")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("T036 production PTY passed file-picker ignore, parent and Git ignore sources")
