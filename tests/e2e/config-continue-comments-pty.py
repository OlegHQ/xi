#!/usr/bin/env python3
"""Prove editor.continue-comments reaches the production Vim newline path."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(config_text: str, expected: str, marker: bytes) -> None:
    with tempfile.TemporaryDirectory(prefix="xi-continue-comments-pty-") as temporary:
        root = Path(temporary)
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(config_text, encoding="utf-8")
        source = root / "main.py"
        source.write_text("", encoding="utf-8")
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
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
            if b"XI_WORKBENCH_READY" not in captured:
                raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
            if marker not in captured:
                raise SystemExit(f"continue-comments config did not reach production wiring\n{captured[-4000:]!r}")
            os.write(master, b"i# one\r\x1b:wq\r")
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        actual = source.read_text(encoding="utf-8")
        if actual != expected:
            raise SystemExit(f"continue-comments production result: expected {expected!r}, got {actual!r}\n{captured[-4000:]!r}")
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")


run("[editor]\ncontinue-comments = true\n", "# one\n# \n", b'XI_CONTINUE_COMMENTS {"enable":true}')
run("[editor]\ncontinue-comments = false\n", "# one\n", b'XI_CONTINUE_COMMENTS {"enable":false}')
print("T036 production PTY passed editor.continue-comments enabled and disabled behavior")
