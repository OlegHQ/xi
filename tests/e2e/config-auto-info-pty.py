#!/usr/bin/env python3
"""Exercise editor.auto-info through the launched editor's prefix-help surface."""
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


def run_case(root: Path, enabled: bool, idle_timeout: int) -> None:
    root.mkdir()
    (root / "main.txt").write_text("hello\n", encoding="utf-8")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(f"[editor]\nauto-info = {'true' if enabled else 'false'}\nidle-timeout = {idle_timeout}\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(root), "XI_UI_TEST_MARKERS": "1"})
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
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start ({enabled=})\n{captured[-3000:]!r}")

        os.write(master, b" ")
        deadline = time.monotonic() + (2 if enabled else 0.3)
        while b"Prefix <Sp" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        visible = b"Prefix <Sp" in captured
        if visible != enabled:
            raise SystemExit(f"auto-info gate mismatch ({enabled=} {visible=})\n{captured[-5000:]!r}")
        os.write(master, b"\x1bq!")
        read_for(master, captured, 0.2)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode} ({enabled=})\n{captured[-8000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-auto-info-pty-") as temporary:
    run_case(Path(temporary) / "enabled", True, 0)
    run_case(Path(temporary) / "disabled", False, 0)

print("T036 production PTY passed editor.auto-info enabled/disabled prefix-help cases")
