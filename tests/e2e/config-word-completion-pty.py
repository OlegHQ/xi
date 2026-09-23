#!/usr/bin/env python3
"""Prove editor.word-completion reaches the launched automatic completion path."""
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
STATE = re.compile(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})")


def read_until(master: int, output: bytearray, ready, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while not ready() and time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], min(0.05, max(0, deadline - time.monotonic())))
        if not readable:
            continue
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            return ready()
    return ready()


def run_case(enabled: bool) -> bool:
    with tempfile.TemporaryDirectory(prefix="xi-word-completion-pty-") as temporary:
        root = Path(temporary)
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(
            "schema-version = 1\n[editor]\nauto-format = false\ncompletion-timeout = 0\n"
            "[editor.word-completion]\n"
            f"enable = {'true' if enabled else 'false'}\ntrigger-length = 3\n",
            encoding="utf-8",
        )
        source = root / "main.txt"
        source.write_text("alphabet alpine\n", encoding="utf-8")
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
            if not read_until(master, captured, lambda: b"XI_WORKBENCH_READY" in captured, 8):
                raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
            os.write(master, b"i")
            for version, key in enumerate(b"alp", 2):
                os.write(master, bytes((key,)))
                marker = f'XI_SYNTAX_STATE {{"documentId":"xi-launch-document","version":{version}'.encode()
                if not read_until(master, captured, lambda: marker in captured, 3):
                    raise SystemExit(f"typed character {chr(key)} did not reach the editor")
            # Enabled completion has a positive terminal state; disabled completion
            # must remain absent for a short window to catch delayed requests.
            if enabled:
                read_until(master, captured, lambda: any(
                    (state := json.loads(match.group(1))).get("state") == "ready"
                    and state.get("items", 0) > 0
                    for match in STATE.finditer(captured)
                ), 4)
            else:
                read_until(master, captured, lambda: False, 0.5)
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            ready = any(state.get("state") == "ready" and state.get("items", 0) > 0 for state in states)
            if ready != enabled:
                markers = [match.group(0).decode("utf-8", "replace") for match in re.finditer(rb"XI_COMPLETION_(?:STATE|OPEN|CLOSED) [^\r\n]*", captured)]
                raise SystemExit(f"word completion enabled={enabled} produced unexpected states: {states!r}; markers={markers!r}")
            os.write(master, b"\x1b:q!\r")
            if child.poll() is None:
                child.wait(timeout=8)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")
        return ready


enabled = run_case(True)
disabled = run_case(False)
if not enabled or disabled:
    raise SystemExit("word-completion enabled/disabled cases did not diverge")
print("Config word-completion PTY passed: bounded open-buffer words appear when enabled and are gated when disabled.")
