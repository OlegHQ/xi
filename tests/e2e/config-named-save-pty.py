#!/usr/bin/env python3
"""Real CLI coverage for missing file targets and naming a scratch buffer with :w."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(root: Path, argument: str | None, steps: list[tuple[bytes, Path, bytes]]) -> None:
    master, slave = pty.openpty()
    env = os.environ.copy()
    env.update({"HOME": str(root), "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    command = ["bun", str(ROOT / "apps/xi/src/main.ts")]
    if argument is not None:
        command.append(argument)
    child = subprocess.Popen(command, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = bytearray()

    def drain(seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    return

    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in output and time.monotonic() < deadline:
            drain(0.05)
        if b"XI_WORKBENCH_READY" not in output:
            raise AssertionError(f"Xi did not start: {output[-3000:]!r}")
        for keys, target, expected in steps:
            os.write(master, keys)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and (not target.exists() or target.read_bytes() != expected):
                drain(0.05)
            assert target.exists() and target.read_bytes() == expected, f"{target}: expected {expected!r}, got {target.read_bytes() if target.exists() else None!r}; {output[-3000:]!r}"
        os.write(master, b":q!\r")
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            drain(0.05)
        assert child.poll() == 0, f"Xi did not exit cleanly: {output[-3000:]!r}"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="xi-named-save-pty-") as temporary:
    root = Path(temporary)
    run(root, "missing.txt", [(b"ihello\x1b:w\r", root / "missing.txt", b"hello\n")])
    run(root, None, [
        (b"ihello\x1b:w named.txt\r", root / "named.txt", b"hello\n"),
        (b"A world\x1b:w\r", root / "named.txt", b"hello world\n"),
    ])
    run(root, None, [(b":e edited.txt\rihello\x1b:w\r", root / "edited.txt", b"hello\n")])
    run(root, None, [(b"ihello\x1b:w named file.txt\r", root / "named file.txt", b"hello\n")])
    run(root, "new.rb", [(b"ihello\x1b:w\r", root / "new.rb", b"hello\n")])
    run(root, "new.ml", [(b"ihello\x1b:w\r", root / "new.ml", b"hello\n")])

print("Named save PTY passed: missing CLI and :edit paths save, and :w name binds scratch for later :w.")
