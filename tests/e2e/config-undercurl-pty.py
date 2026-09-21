#!/usr/bin/env python3
"""Exercise editor.undercurl through the launched editor."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-undercurl-pty-") as temporary:
    root = Path(temporary)
    source = root / "main.txt"
    source.write_text("undercurl\n", encoding="utf-8")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor]\nundercurl = true\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.pop("COLORTERM", None)
    environment.pop("TERM_PROGRAM", None)
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
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
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
        if b'XI_COLOR_MODE {"colorMode":"ansi256","trueColor":false,"undercurl":true' not in captured:
            raise SystemExit(f"undercurl config did not reach the launched UI\n{captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {bytes(captured[-4000:])!r}")

print("T036 production PTY passed editor.undercurl")
