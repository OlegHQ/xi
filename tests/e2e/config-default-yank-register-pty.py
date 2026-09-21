#!/usr/bin/env python3
"""Exercise editor.default-yank-register through the launched Vim session."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-default-yank-register-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.txt"
    source.write_text("ab\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\ndefault-yank-register = "a"\n[editor.lsp]\nauto-signature-help = false\n', encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
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
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")

        # Explicitly yank into b, then read the configured default register a. If the
        # setting is ignored, the unnamed register would insert the yanked byte.
        os.write(master, b'"bylA\x12a\x1b')
        time.sleep(0.2)
        os.write(master, b":wq\r")
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
        if child.poll() is None:
            raise SystemExit(f"Xi did not exit after :wq\n{captured[-3000:]!r}")
        if source.read_text(encoding="utf-8") != "ab\n":
            raise SystemExit(f"configured default register was not used for <C-r>: {source.read_text(encoding='utf-8')!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}\n{captured[-5000:]!r}")

print("Config default-yank-register PTY passed: the launched editor read the configured register.")
