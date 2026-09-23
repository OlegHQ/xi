#!/usr/bin/env python3
"""Picker and search agree on ignores beneath a linked worktree and nested root."""
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
    raise AssertionError(f"expected terminal output missing: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-search-ignore-") as temporary:
    parent = Path(temporary) / "linked"
    workspace = parent / "child"
    workspace.mkdir(parents=True)
    gitdir = Path(temporary) / "git-meta" / "worktree"
    gitdir.mkdir(parents=True)
    common = Path(temporary) / "git-meta" / "common"
    (common / "info").mkdir(parents=True)
    (parent / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")
    (gitdir / "commondir").write_text("../common\n", encoding="utf-8")
    (common / "info" / "exclude").write_text("excluded.txt\n", encoding="utf-8")
    (parent / ".gitignore").write_text("parent.txt\n*.log\n!included.log\ngenerated/\n", encoding="utf-8")
    (parent / ".ignore").write_text("local.txt\n", encoding="utf-8")
    xdg_config = Path(temporary) / "xdg"
    global_ignore = xdg_config / "git" / "ignore"
    global_ignore.parent.mkdir(parents=True)
    global_ignore.write_text("global.txt\n", encoding="utf-8")
    (workspace / "generated").mkdir()
    for name in ("parent.txt", "excluded.txt", "local.txt", "global.txt", "ignored.log", "included.log", "visible.txt", ".hidden.txt", "generated/junk.txt"):
        (workspace / name).write_text(f"needle {name}\n", encoding="utf-8")
    master, slave = pty.openpty()
    command = [str(args.binary.resolve())] if args.binary else ["bun", "run", str(ROOT / "apps/xi/src/main.ts")]
    child = subprocess.Popen(
        [*command, "parent.txt"],
        cwd=workspace,
        env={**os.environ, "HOME": temporary, "XDG_CONFIG_HOME": str(xdg_config), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"},
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
            and item.get("state") == "ready" and item.get("totalMatches") == 2
            and item.get("firstPath") == "included.log"
            for match in RESULT.finditer(data)
        ), 5)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        wait_for(master, captured, lambda data: b"XI_SEARCH_CANCELLED" in data, 5)
        captured.clear()
        os.write(master, b" fincluded.log")
        wait_for(master, captured, lambda data: b"XI_PICKER_PREVIEW" in data and b"included.log" in data, 5)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        captured.clear()
        os.write(master, b" fparent.txt")
        wait_for(master, captured, lambda data: b"No matches" in data, 5)
        assert b"XI_PICKER_PREVIEW" not in captured, "ignored parent file appeared in picker"
        os.write(master, b"\x1b")
        captured.clear()
        os.write(master, b" f")
        wait_for(master, captured, lambda data: b"3 matches" in data, 5)
        captured.clear()
        os.write(master, b"global.txt")
        wait_for(master, captured, lambda data: b"No matches" in data, 5)
        assert b"XI_PICKER_PREVIEW" not in captured, "XDG Git global ignore did not reach picker"
        os.write(master, b"\x1b")
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    assert child.returncode == 0, f"Xi exited {child.returncode}: {captured[-4000:]!r}"

print("Picker/search linked-worktree ignore PTY passed")
