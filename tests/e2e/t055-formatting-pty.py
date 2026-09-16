#!/usr/bin/env python3
"""Exercise real format-on-save and concurrent typing through the launcher."""
from __future__ import annotations

import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUN = shutil.which("bun")
if BUN is None:
    raise SystemExit("T055 requires the pinned bun executable")


def read_until(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if marker in captured:
            return
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return
    raise SystemExit(f"missing {marker!r}; captured={captured[-3000:]!r}")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def launch(path: Path, temporary: str, formatter: str) -> tuple[int, int, subprocess.Popen[bytes], bytearray]:
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "TERM": "xterm-256color",
        "HOME": temporary,
        "XI_UI_TEST_MARKERS": "1",
        "XI_FORMAT_ON_SAVE": "1",
        "XI_FORMATTER_COMMAND": BUN,
        "XI_FORMATTER_ARGS": json.dumps(["-e", formatter]),
    })
    child = subprocess.Popen(
        [BUN, "run", "apps/xi/src/main.ts", str(path)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    return master, slave, child, bytearray()


with tempfile.TemporaryDirectory(prefix="xi-t055-format-") as temporary:
    workspace = Path(temporary)
    success_path = workspace / "success.ts"
    success_path.write_text("const x=1;\n", encoding="utf-8")
    stable_formatter = 'const text = await new Response(Bun.stdin).text(); await Bun.sleep(200); process.stdout.write(text.replace(/\\s*=\\s*/g, " = "));'
    master, _, child, captured = launch(success_path, temporary, stable_formatter)
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b"i")
        read_for(master, captured, 0.05)
        os.write(master, b"A")
        read_for(master, captured, 0.05)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.15)
        os.write(master, b"\x13")
        time.sleep(0.03)
        os.write(master, b"i")
        time.sleep(0.03)
        os.write(master, b"B")
        time.sleep(0.03)
        os.write(master, b"\x1b")
        expected = "ABconst x = 1;\n"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and success_path.read_text(encoding="utf-8") != expected:
            read_for(master, captured, 0.05)
        if success_path.read_text(encoding="utf-8") != expected:
            raise SystemExit(f"T055 concurrent save lost input: {success_path.read_text(encoding='utf-8')!r}")
        if b"XI_FORMAT_APPLIED" not in captured:
            raise SystemExit("T055 successful format did not report an applied formatter result")
        os.write(master, b"q")
        read_for(master, captured, 2)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"T055 successful formatter process exited {child.returncode}")

    failure_path = workspace / "failure.ts"
    original = "const y=2;\n"
    failure_path.write_text(original, encoding="utf-8")
    failing_formatter = 'process.stderr.write("fixture formatter failure"); process.exit(7);'
    master, _, child, captured = launch(failure_path, temporary, failing_formatter)
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b"i")
        read_for(master, captured, 0.05)
        os.write(master, b"C")
        read_for(master, captured, 0.05)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.15)
        os.write(master, b"\x13")
        read_until(master, captured, b"XI_FORMAT_ERROR", 5)
        if failure_path.read_text(encoding="utf-8") != original:
            raise SystemExit("T055 formatter failure overwrote the disk file")
        os.write(master, b"q")
        read_for(master, captured, 2)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"T055 failing formatter process exited {child.returncode}")

print("T055 production PTY passed stable real formatter, concurrent typing preservation and failure-safe save")
