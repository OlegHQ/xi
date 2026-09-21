#!/usr/bin/env python3
"""Exercise the production signature-help documentation visibility setting."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = re.compile(rb"XI_SIGNATURE_STATE (\{[^\r\n]*\})")


with tempfile.TemporaryDirectory(prefix="xi-t036-lsp-signature-docs-") as temporary:
    workspace = Path(temporary)
    (workspace / "package.json").write_text("{}\n", encoding="utf-8")
    (workspace / "main.ts").write_text("Math.max(\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor.lsp]\ndisplay-signature-help-docs = false\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"],
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
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
        # Kitty keyboard protocol preserves Ctrl+Shift+S as CSI-u; Xi maps it to
        # manual signature help in insert mode.
        os.write(master, b"$a\x1b[115;6u")
        deadline = time.monotonic() + 15
        states = []
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            if any(state.get("state") == "ready" for state in states):
                break
        if not any(state.get("state") == "ready" for state in states):
            raise SystemExit(f"signature help never reached ready state: {states!r}\n{captured[-4000:]!r}")
        if not any(state.get("state") == "ready" and state.get("documentation") is False for state in states):
            raise SystemExit(f"signature documentation remained visible: {states!r}")
        os.write(master, b"\x1b\x1b")
        time.sleep(0.1)
        os.write(master, b":q!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production signature-help PTY exited {child.returncode}\n{captured[-8000:]!r}")

print("T036 production PTY passed signature-help documentation suppression through the configured LSP path")
