#!/usr/bin/env python3
"""Exercise editor.auto-save.focus-lost through a real terminal focus event."""
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


with tempfile.TemporaryDirectory(prefix="xi-auto-save-focus-pty-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.txt"
    source.write_text("hello\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor]\nauto-save = true\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
        cwd=workspace,
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
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
        os.write(master, b"\x1b[I")
        os.write(master, b"iA")
        time.sleep(0.05)
        os.write(master, b"\x1b")
        time.sleep(0.05)
        if source.read_text(encoding="utf-8") != "hello\n":
            raise SystemExit("edit unexpectedly saved before focus loss")
        os.write(master, b"\x1b[O")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and source.read_text(encoding="utf-8") != "Ahello\n":
            read_for(master, captured, 0.05)
        if source.read_text(encoding="utf-8") != "Ahello\n":
            raise SystemExit(f"focus-lost auto-save did not persist the edit: {source.read_text(encoding='utf-8')!r} output={captured[-4000:]!r}")
        if b'XI_AUTO_SAVE_FOCUS {"focused":false,"enabled":true}' not in captured:
            raise SystemExit(f"focus-lost event was not observed\n{captured[-4000:]!r}")
        os.write(master, b"q")
        read_for(master, captured, 0.5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}\n{captured[-5000:]!r}")

print("T036 production PTY passed editor.auto-save.focus-lost")
