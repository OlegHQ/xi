#!/usr/bin/env python3
"""Prove custom Helix clipboard commands cross Xi's real Vim/register path."""
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


with tempfile.TemporaryDirectory(prefix="xi-clipboard-provider-pty-") as temporary:
    root = Path(temporary)
    source = root / "main.txt"
    source.write_text("one\ntwo", encoding="utf-8")
    clipboard = root / "clipboard.txt"
    primary = root / "primary.txt"
    primary.write_text("PRIMARY", encoding="utf-8")
    script = root / "clipboard.py"
    script.write_text(
        "import pathlib, sys\n"
        "path = pathlib.Path(__import__('os').environ['XI_TEST_CLIPBOARD'])\n"
        "if sys.argv[1] in ('paste', 'primary-paste'): pathlib.Path(__import__('os').environ['XI_TEST_PRIMARY'] if sys.argv[1] == 'primary-paste' else path).write_text(sys.stdin.read(), encoding='utf-8')\n"
        "elif sys.argv[1] == 'primary-yank': sys.stdout.write(pathlib.Path(__import__('os').environ['XI_TEST_PRIMARY']).read_text(encoding='utf-8'))\n"
        "else: sys.stdout.write(path.read_text(encoding='utf-8'))\n",
        encoding="utf-8",
    )
    command = f'{{ command = "python3", args = ["{script}", "yank"] }}'
    paste = f'{{ command = "python3", args = ["{script}", "paste"] }}'
    primary_yank = f'{{ command = "python3", args = ["{script}", "primary-yank"] }}'
    primary_paste = f'{{ command = "python3", args = ["{script}", "primary-paste"] }}'
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[editor.clipboard-provider.custom]\n"
        f"yank = {command}\n"
        f"paste = {paste}\n"
        f"primary-yank = {primary_yank}\n"
        f"primary-paste = {primary_paste}\n",
        encoding="utf-8",
    )
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1", "XI_TEST_CLIPBOARD": str(clipboard), "XI_TEST_PRIMARY": str(primary)})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=ROOT,
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
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")

        os.write(master, b' Y')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (not clipboard.exists() or clipboard.read_text(encoding="utf-8") != "one\n"):
            read_for(master, captured, 0.05)
        if not clipboard.exists() or clipboard.read_text(encoding="utf-8") != "one\n":
            raise SystemExit(f"Space+Shift+Y did not copy the line to the + register: {captured[-5000:]!r}")

        os.write(master, b'"+yy')

        os.write(master, b'gg"*yy')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (not primary.exists() or primary.read_text(encoding="utf-8") != "one\n"):
            read_for(master, captured, 0.05)
        if not primary.exists() or primary.read_text(encoding="utf-8") != "one\n":
            raise SystemExit(f"custom primary yank command did not receive the * register: {captured[-5000:]!r}")

        primary.write_text("PRIMARY", encoding="utf-8")
        os.write(master, b'j"+p')
        read_for(master, captured, 0.5)
        os.write(master, b'gg"*p')
        read_for(master, captured, 0.5)
        os.write(master, b"\x1b:wq\r")
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if child.poll() is None:
            raise SystemExit(f"Xi did not exit after :wq: {captured[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")
    result = source.read_text(encoding="utf-8")
    # EOF linewise put followed by gg preserves column zero, as in pinned Neovim.
    if result != "oPRIMARYne\ntwo\none\n":
        raise SystemExit(f"custom clipboard paste did not reach the document: {result!r}")

print("T036 custom clipboard-provider PTY passed: configured yank/paste commands reached + register semantics.")
