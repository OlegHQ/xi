#!/usr/bin/env python3
"""Prove editor.middle-click-paste through the real SGR pointer and clipboard paths."""
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


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


with tempfile.TemporaryDirectory(prefix="xi-middle-click-paste-pty-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.txt"
    source.write_text("hello\n", encoding="utf-8")
    primary = workspace / "primary.txt"
    primary.write_text("PRIMARY", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[editor]\n"
        "middle-click-paste = true\n"
        "[editor.clipboard-provider.custom]\n"
        "yank = { command = \"cat\" }\n"
        "paste = { command = \"cat\" }\n"
        f"primary-yank = {{ command = \"cat\", args = [\"{primary}\"] }}\n",
        encoding="utf-8",
    )
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
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

        os.write(master, mouse(1, 8, 2))
        deadline = time.monotonic() + 5
        while b"XI_MIDDLE_CLICK_PASTE" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if b"XI_MIDDLE_CLICK_PASTE" not in captured:
            raise SystemExit(f"real SGR middle click did not reach the paste owner: {captured[-5000:]!r}")
        read_for(master, captured, 0.8)
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
    if "PRIMARY" not in result:
        raise SystemExit(f"middle-click primary paste did not reach the document: {result!r}")

print("T036 editor.middle-click-paste PTY passed: a real SGR middle click pasted the configured primary selection.")
