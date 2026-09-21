#!/usr/bin/env python3
"""Prove editor.end-of-line-diagnostics changes launched inline diagnostic output."""
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
MESSAGE = b"Type 'string' is not assignable to type 'number'."


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


def run_case(config_source: str, label: str) -> None:
    with tempfile.TemporaryDirectory(prefix="xi-end-of-line-diagnostics-pty-") as temporary:
        root = Path(temporary)
        node_modules = root / "node_modules"
        node_modules.mkdir()
        (node_modules / "typescript").symlink_to(ROOT / "node_modules" / "typescript")
        (root / "package.json").write_text("{}\n", encoding="utf-8")
        (root / "broken.ts").write_text("const x: number = 'bad';\n", encoding="utf-8")
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(config_source, encoding="utf-8")

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
                lines = visible(captured).splitlines()
                if any(b"const x: number" in line and MESSAGE in line for line in lines):
                    break
            else:
                raise SystemExit(f"{label} end-of-line diagnostic did not render on the source row: {visible(captured)[-6000:]!r}")
            os.write(master, b"q")
            child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"{label} Xi exited {child.returncode}: {visible(captured)[-6000:]!r}")


if shutil.which("typescript-language-server") is None:
    print("Config end-of-line-diagnostics PTY: SKIPPED 'typescript-language-server' is not installed on this host")
else:
    run_case("schema-version = 1\n[editor]\nend-of-line-diagnostics = \"error\"\n", "configured")
    run_case("schema-version = 1\n", "master default")
    print("Config end-of-line-diagnostics PTY passed: explicit and master-default diagnostics rendered on the source row.")
