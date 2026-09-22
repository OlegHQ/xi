#!/usr/bin/env python3
"""A query made during indexing gains a late file without another keystroke."""
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def wait_for(master: int, output: bytearray, needle: bytes) -> None:
    deadline = time.monotonic() + 8
    while needle not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            output.extend(os.read(master, 65536))
    if needle not in output:
        raise AssertionError(f"missing {needle!r}: {bytes(output[-1000:])!r}")


with tempfile.TemporaryDirectory(prefix="xi-picker-incremental-") as temporary:
    root = Path(temporary)
    workspace = root / "workspace"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    (workspace / "probe.txt").write_text("probe\n")
    for index in range(1024):
        (workspace / f"file-{index:04d}.txt").touch()
    late = workspace / "late"
    late.mkdir()
    (late / "target_unique.txt").write_text("late result\n")
    master, slave = pty.openpty()
    env = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_"))}
    env.update(HOME=str(root), TERM="xterm-256color", XI_UI_TEST_MARKERS="1")
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(workspace / "probe.txt")],
                             cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    try:
        wait_for(master, output, b"XI_WORKBENCH_READY")
        os.write(master, b" f")
        wait_for(master, output, b'XI_FILE_INDEX {"entries":128,"complete":false')
        os.write(master, b"target_unique")
        wait_for(master, output, b'target_unique.txt"}')
        assert b"target_unique.txt" in output.split(b"XI_PICKER_PREVIEW")[-1], "late file was not previewed"
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
        assert child.returncode == 0, f"Xi exited {child.returncode}"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

print("T039 incremental picker found a late file without another key")
