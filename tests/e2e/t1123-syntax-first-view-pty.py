#!/usr/bin/env python3
"""A launched 250-line TypeScript file paints its first viewport in one syntax batch."""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = re.compile(rb"XI_SYNTAX_STATE (\{[^\r\n]*\})")


def run() -> tuple[int, int]:
    with tempfile.TemporaryDirectory(prefix="xi-def1123-view-") as temporary:
        source = Path(temporary) / "main.ts"
        source.write_text("const value = 1;\n" * 250, encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        environment = {**os.environ, "HOME": temporary, "XDG_CONFIG_HOME": "", "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"}
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
                                 stdin=slave, stdout=slave, stderr=slave, env=environment)
        os.close(slave)
        captured = bytearray()
        started = time.monotonic()
        try:
            deadline = started + 5
            first_spans = 0
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
                counts = [json.loads(match.group(1))["spanCount"] for match in STATE.finditer(captured)]
                first_spans = next((count for count in counts if count > 0), 0)
                if first_spans:
                    break
            if b"XI_WORKBENCH_READY" not in captured or first_spans < 200:
                raise SystemExit(f"first viewport was not highlighted as one batch: spans={first_spans}, output={captured[-2000:]!r}")
            return first_spans, round((time.monotonic() - started) * 1000)
        finally:
            if child.poll() is None:
                os.write(master, b":q!\r")
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)


cold, cold_ms = run()
warm, warm_ms = run()
print(f"DEF-1123 first viewport PTY passed: first syntax batch spans cold={cold} warm={warm}; observed open-to-batch cold={cold_ms}ms warm={warm_ms}ms")
