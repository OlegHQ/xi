#!/usr/bin/env python3
"""Exercise the global auto-format gate on the production save path."""
from __future__ import annotations

import json
import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-t036-auto-format-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.ts"
    source.write_text("const x=1;\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[editor]\nauto-format = false\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "TERM": "xterm-256color",
        "HOME": temporary,
        "XI_UI_TEST_MARKERS": "1",
        "XI_FORMATTER_COMMAND": "bun",
        "XI_FORMATTER_ARGS": json.dumps(["-e", 'process.stdout.write((await new Response(Bun.stdin).text()).replace(/\\s*=\\s*/g, " = "));']),
    })
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
        os.write(master, b"iA")
        time.sleep(0.1)
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b"\x13")
        deadline = time.monotonic() + 8
        expected = "Aconst x=1;\n"
        while time.monotonic() < deadline and source.read_text(encoding="utf-8") != expected:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if source.read_text(encoding="utf-8") != expected:
            raise SystemExit(f"global auto-format gate did not suppress formatting: {source.read_text(encoding='utf-8')!r}")
        if b"XI_FORMAT_APPLIED" in captured:
            raise SystemExit("formatter ran while editor.auto-format was false")
        os.write(master, b":q!\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production auto-format PTY exited {child.returncode}\n{captured[-5000:]!r}")

print("T036 production PTY passed the global auto-format gate")
