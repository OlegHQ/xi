#!/usr/bin/env python3
"""Dirty ignored buffers obey the same search policy as ripgrep on disk."""
import json
import argparse
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULT = re.compile(rb"XI_SEARCH_RESULT (\{[^\r\n]*\})")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, help="packaged Xi binary; defaults to the Bun source command")
args = parser.parse_args()


def wait_for(master, captured, predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        if select.select([master], [], [], 0.05)[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
    raise AssertionError(f"search marker missing: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-search-ignore-") as temporary:
    workspace = Path(temporary)
    subprocess.run(["git", "init", "-q", str(workspace)], check=True)
    (workspace / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (workspace / "ignored.txt").write_text("needle ignored\n", encoding="utf-8")
    (workspace / "visible.txt").write_text("needle visible\n", encoding="utf-8")
    master, slave = pty.openpty()
    command = [str(args.binary.resolve())] if args.binary else ["bun", "run", str(ROOT / "apps/xi/src/main.ts")]
    child = subprocess.Popen(
        [*command, "ignored.txt"],
        cwd=workspace,
        env={**os.environ, "HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"},
        stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, lambda data: b"XI_WORKBENCH_READY" in data, 10)
        os.write(master, b"A dirty\x1b")
        time.sleep(0.1)
        os.write(master, b" /needle")
        wait_for(master, captured, lambda data: any(
            (item := json.loads(match.group(1))).get("query") == "needle"
            and item.get("state") == "ready" and item.get("totalMatches") == 1
            and item.get("firstPath") == "visible.txt"
            for match in RESULT.finditer(data)
        ), 5)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        wait_for(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    assert child.returncode == 0, f"Xi exited {child.returncode}: {captured[-4000:]!r}"

print("Dirty ignored buffer PTY passed")
