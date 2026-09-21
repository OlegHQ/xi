#!/usr/bin/env python3
"""Prove editor.path-completion on the launched Xi completion path."""
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
OPEN = re.compile(rb"XI_COMPLETION_OPEN (\{[^\r\n]*\})")
STATE = re.compile(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def run_case(enabled: bool) -> bytes:
    with tempfile.TemporaryDirectory(prefix="xi-path-completion-pty-") as temporary:
        workspace = Path(temporary)
        (workspace / "src").mkdir()
        (workspace / "src" / "alpha.ts").write_text("export {}\n", encoding="utf-8")
        (workspace / "src" / "beta.txt").write_text("beta\n", encoding="utf-8")
        config = workspace / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(f"schema-version = 1\n[editor]\npath-completion = {'true' if enabled else 'false'}\nauto-format = false\ncompletion-timeout = 0\n[editor.lsp]\nauto-signature-help = false\n", encoding="utf-8")
        source = workspace / "main.txt"
        source.write_text("x\n", encoding="utf-8")
        master, slave = pty.openpty()
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            read_for(master, captured, 10)
            if b"XI_WORKBENCH_READY" not in captured:
                raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
            os.write(master, b"i./src/")
            read_for(master, captured, 2)
            opens = [match.group(1) for match in OPEN.finditer(captured)]
            states = [match.group(1) for match in STATE.finditer(captured)]
            if enabled and not any(b'"source":"path"' in value for value in opens):
                raise SystemExit(f"path completion did not open: {captured[-4000:]!r}")
            if enabled and not any(b'"items":2' in value for value in states):
                raise SystemExit(f"path completion did not enumerate both files: {captured[-4000:]!r}")
            if not enabled and any(b'"source":"path"' in value for value in opens):
                raise SystemExit(f"disabled path completion opened unexpectedly: {captured[-4000:]!r}")
            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            os.write(master, b":q!\r")
            read_for(master, captured, 2)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise SystemExit(f"Xi did not quit after path completion test: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")
        return captured


run_case(True)
run_case(False)
print("Config path-completion PTY passed: recognized paths enumerate bounded directory candidates and the setting gates the production popup.")
