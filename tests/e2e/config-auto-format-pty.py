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

from terminal_screen import Screen

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
        stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    diagnostics = bytearray()
    screen = Screen(24, 80)
    assert child.stderr is not None

    def pump(timeout: float = 0.05) -> None:
        for descriptor in select.select([master, child.stderr.fileno()], [], [], timeout)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                continue
            if descriptor == master:
                captured.extend(data)
                screen.feed(data)
            else:
                diagnostics.extend(data)

    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in diagnostics and time.monotonic() < deadline:
            pump()
        if b"XI_WORKBENCH_READY" not in diagnostics:
            raise SystemExit(f"workbench did not start\n{diagnostics[-3000:]!r}")
        os.write(master, b"iA")
        time.sleep(0.1)
        os.write(master, b"\x1b")
        deadline = time.monotonic() + 3
        while ("NOR" not in screen.row_text(24) or "main.ts [+]" not in screen.row_text(24)) and time.monotonic() < deadline:
            pump()
        if "NOR" not in screen.row_text(24) or "main.ts [+]" not in screen.row_text(24):
            raise SystemExit(f"Escape did not leave insert mode: {screen.row_text(24)!r}")
        os.write(master, b"\x13")
        deadline = time.monotonic() + 8
        expected = "Aconst x=1;\n"
        while time.monotonic() < deadline and source.read_text(encoding="utf-8") != expected:
            pump()
        if source.read_text(encoding="utf-8") != expected:
            raise SystemExit(f"global auto-format gate did not suppress formatting: {source.read_text(encoding='utf-8')!r}")
        if b"XI_FORMAT_APPLIED" in diagnostics:
            raise SystemExit("formatter ran while editor.auto-format was false")
        os.write(master, b":q!\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            pump()
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production auto-format PTY exited {child.returncode}\n{captured[-5000:]!r}")

print("T036 production PTY passed the global auto-format gate")
