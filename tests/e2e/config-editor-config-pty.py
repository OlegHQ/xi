#!/usr/bin/env python3
"""Prove editor.editor-config gates the project .helix/config.toml layer."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-editor-config-pty-") as temporary:
    root = Path(temporary)
    (root / ".config" / "xi").mkdir(parents=True)
    (root / ".config" / "xi" / "config.toml").write_text("[editor]\neditor-config = false\n", encoding="utf-8")
    (root / ".helix").mkdir()
    (root / ".helix" / "config.toml").write_text("[editor]\nline-number = \"relative\"\n", encoding="utf-8")
    (root / "main.txt").write_text("text\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
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
        if b'XI_EDITOR_CONFIG {"enabled":false,"lineNumber":"absolute"}' not in captured:
            raise SystemExit(f"editor-config did not gate the project layer\n{captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {bytes(captured[-4000:])!r}")

print("T036 production PTY passed editor.editor-config")
