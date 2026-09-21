#!/usr/bin/env python3
"""Prove editor.file-explorer.flatten-dirs changes the launched Explorer rows."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REFRESH = re.compile(rb"XI_EXPLORER_REFRESH (\{[^\r\n]*\})")


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def run_case(flatten: bool) -> list[dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="xi-file-explorer-flatten-pty-") as temporary:
        root = Path(temporary)
        config = root / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(f"[editor.file-explorer]\nflatten-dirs = {'true' if flatten else 'false'}\n", encoding="utf-8")
        chain = root / "chain" / "one" / "two"
        chain.mkdir(parents=True)
        (chain / "leaf.txt").write_text("leaf\n", encoding="utf-8")
        source = root / "chain" / "one" / "two" / "leaf.txt"
        master, slave = pty.openpty()
        environment = os.environ.copy()
        environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            read_for(master, captured, 10)
            if b"XI_WORKBENCH_READY" not in captured:
                raise SystemExit(f"workbench did not start: {captured[-4000:]!r}")
            os.write(master, b" vf")
            read_for(master, captured, 3)
            os.write(master, b"j")
            read_for(master, captured, 1)
            os.write(master, b"l")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
                if any(item.get("state") == "ready" and ("chain/one" in item.get("visibleLabels", []) if flatten else "one" in item.get("visibleLabels", [])) for item in matches):
                    break
                read_for(master, captured, 0.05)
            matches = [json.loads(match.group(1)) for match in REFRESH.finditer(captured)]
            if not any(item.get("state") == "ready" and item.get("flattenDirs") is flatten for item in matches):
                raise SystemExit(f"flatten-dirs policy was not wired: flatten={flatten} matches={matches[-8:]!r}")
            if flatten and not any("chain/one" in item.get("visibleLabels", []) for item in matches):
                raise SystemExit(f"flatten-dirs=true did not flatten the first chain: {matches[-8:]!r}")
            if not flatten and any("chain/one" in item.get("visibleLabels", []) for item in matches):
                raise SystemExit(f"flatten-dirs=false unexpectedly flattened the first chain: {matches[-8:]!r}")
            os.write(master, b"\x1bq")
            child.wait(timeout=5)
            return matches
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
            if child.returncode != 0:
                raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")


run_case(True)
run_case(False)
print("Config file-explorer flatten-dirs PTY passed: true flattened loaded directory chains and false preserved separate rows.")
