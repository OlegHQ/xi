#!/usr/bin/env python3
"""Exercise dd and Visual row deletion in the launched Files tree."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def drain(master: int, output: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                return


def wait_for(master: int, output: bytearray, marker: bytes, seconds: float = 8) -> None:
    deadline = time.monotonic() + seconds
    while marker not in output and time.monotonic() < deadline:
        drain(master, output, 0.05)
    assert marker in output, f"missing {marker!r}: {output[-3000:]!r}"


def run_case(files: dict[str, bytes], keys: bytes, removed: tuple[str, ...]) -> None:
    with tempfile.TemporaryDirectory(prefix="xi-explorer-vim-rows-") as temporary:
        workspace = Path(temporary)
        for name, content in files.items():
            (workspace / name).write_bytes(content)
        master, slave = pty.openpty()
        env = os.environ.copy()
        env.update(HOME=temporary, TERM="xterm-256color", XI_UI_TEST_MARKERS="1")
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "seed.txt"],
                                 cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = bytearray()
        try:
            wait_for(master, output, b"XI_WORKBENCH_READY")
            os.write(master, b" vf")
            wait_for(master, output, b"XI_EXPLORER_OPEN")
            drain(master, output, 0.5)
            before = len(output)
            os.write(master, keys)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and any((workspace / name).exists() for name in removed):
                drain(master, output, 0.05)
            assert all(not (workspace / name).exists() for name in removed), f"keys {keys!r} did not trash {removed}: {output[before:][-3000:]!r}"
            assert files["seed.txt"] == (workspace / "seed.txt").read_bytes(), "editing Files changed the open buffer"
            os.write(master, b"u")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and any(not (workspace / name).exists() for name in removed):
                drain(master, output, 0.05)
            assert all((workspace / name).read_bytes() == files[name] for name in removed), "one u did not restore all selected files"
            os.write(master, b"\x1b:qa!\r")
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                drain(master, output, 0.05)
            assert child.returncode == 0, f"Xi exited {child.returncode}: {output[-3000:]!r}"
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)


run_case({"seed.txt": b"seed\n", "victim.txt": b"victim\n"}, b"jjdd", ("victim.txt",))
run_case({"a.txt": b"a\n", "b.txt": b"b\n", "seed.txt": b"seed\n"}, b"ggjvjx", ("a.txt", "b.txt"))
print("Explorer Vim rows PTY passed: dd and Visual x trash entries; one u restores each operation")
