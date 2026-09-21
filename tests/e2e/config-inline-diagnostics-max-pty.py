#!/usr/bin/env python3
"""Prove editor.inline-diagnostics.max-diagnostics limits launched inline output."""
from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
FIRST = b"Type 'string' is not assignable to type 'number'."
SECOND = b"Type 'number' is not assignable to type 'string'."
PREFIX = "└─── ".encode()


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        captured.extend(chunk)


def visible(captured: bytearray) -> bytes:
    return ANSI.sub(b"", bytes(captured)).replace(b"\r", b"")


if shutil.which("typescript-language-server") is None:
    print("Config inline-diagnostics max PTY: SKIPPED 'typescript-language-server' is not installed on this host")
else:
    with tempfile.TemporaryDirectory(prefix="xi-inline-diagnostics-max-pty-") as temporary:
        root = Path(temporary)
        node_modules = root / "node_modules"
        node_modules.mkdir()
        (node_modules / "typescript").symlink_to(ROOT / "node_modules" / "typescript")
        (root / "package.json").write_text("{}\n", encoding="utf-8")
        source = root / "broken.ts"
        source.write_text('const first: number = "first-error"; const second: string = 42;\nconst third: boolean = 1;\n', encoding="utf-8")
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text("schema-version = 1\n[editor]\nend-of-line-diagnostics = \"disable\"\n[editor.inline-diagnostics]\ncursor-line = \"error\"\nother-lines = \"disable\"\nprefix-len = 3\nmax-wrap = 0\nmin-diagnostic-width = 40\nmax-diagnostics = 1\n", encoding="utf-8")

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": str(root), "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "broken.ts"],
            cwd=str(root),
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
        os.close(slave)
        captured = bytearray()
        try:
            deadline = time.monotonic() + 45
            os.write(master, b" k")
            while time.monotonic() < deadline:
                read_for(master, captured, 0.5)
                output = visible(captured)
                if FIRST in output:
                    if SECOND in output:
                        raise SystemExit(f"max-diagnostics rendered a second same-line diagnostic: {output[-6000:]!r}")
                    if b"Type 'number' is not assignable to type 'boolean'." in output:
                        raise SystemExit(f"other-lines=disable rendered an off-cursor diagnostic: {output[-6000:]!r}")
                    if PREFIX not in output:
                        raise SystemExit(f"prefix-len=3 did not change the launched diagnostic prefix: {output[-6000:]!r}")
                    break
            else:
                raise SystemExit(f"configured inline diagnostic did not arrive: {visible(captured)[-6000:]!r}")
            os.write(master, b"q")
            child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {visible(captured)[-6000:]!r}")

    print("Config inline-diagnostics PTY passed: cursor-line=error, other-lines=disable, prefix-len=3 and max-wrap=0 changed launched inline output.")
