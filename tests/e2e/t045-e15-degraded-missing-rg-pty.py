#!/usr/bin/env python3
"""T045/E15: read-only/permission errors, missing rg/Git/server -- through the production CLI.
docs/testing.md's E15 row: "Clear degraded state; plain editing works." This
fixture covers the "missing rg" case specifically: launches the real production CLI with an
empty PATH (so the search service's ripgrep spawn genuinely fails with ENOENT, not a mocked
error), confirms the resulting degraded state is reported clearly (not a crash, not a silent
hang), and confirms ordinary editing/save through the same session is completely unaffected.
"""
from __future__ import annotations

import json
import os
import pty
import re
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULT = re.compile(rb"XI_SEARCH_RESULT (\{[^\r\n]*\})")


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


def read_until(master: int, captured: bytearray, predicate, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(captured):
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"missing marker; captured tail={captured[-4000:]!r}")


bun = shutil.which("bun")
if bun is None:
    print("T045-E15-DEGRADED-MISSING-RG-PTY: SKIPPED bun is not resolvable via PATH on this host")
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="xi-t045-e15-") as temporary:
    workspace = Path(temporary)
    (workspace / "src").mkdir()
    (workspace / "src" / "target.txt").write_text("needle from disk\n", encoding="utf-8")
    empty_path_dir = workspace / "empty-path"
    empty_path_dir.mkdir()
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1",
        # A directory with nothing in it: 'rg' (and every other external tool) is genuinely
        # unresolvable, not merely unset -- the spawn itself fails with ENOENT.
        "PATH": str(empty_path_dir),
    })
    child = subprocess.Popen(
        [bun, "run", str(ROOT / "apps/xi/src/main.ts"), "src/target.txt"],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, lambda data: b"XI_WORKBENCH_READY" in data, 10)
        os.write(master, b" /")
        read_until(master, captured, lambda data: b"XI_SEARCH_OPEN" in data, 5)
        os.write(master, b"needle")
        read_until(
            master, captured,
            lambda data: any(json.loads(m.group(1)).get("state") == "error" for m in RESULT.finditer(data)),
            5,
        )
        errored = [json.loads(m.group(1)) for m in RESULT.finditer(captured) if json.loads(m.group(1)).get("state") == "error"]
        if not errored or not errored[-1].get("message"):
            raise SystemExit(f"missing rg did not produce a clear degraded error message: {errored!r}")
        # Search uses Vim-like modes: first Escape leaves query editing, second closes.
        os.write(master, b"\x1b")
        read_for(master, captured, 0.15)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.3)

        # Plain editing through the SAME session is completely unaffected by the degraded
        # search backend: edit the already-open file, save it, verify exact bytes.
        os.write(master, b"ggIEDITED \x1b")
        read_for(master, captured, 0.3)
        os.write(master, b":wq\r")
        read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production CLI with missing rg exited {child.returncode}: {captured[-4000:]!r}")
    final_text = (workspace / "src" / "target.txt").read_text(encoding="utf-8")
    if final_text != "EDITED needle from disk\n":
        raise SystemExit(f"plain editing did not work correctly alongside the degraded search state: {final_text!r}")

print("T045-E15-DEGRADED-MISSING-RG-PTY pass: missing rg produced a clear degraded search "
      "error state (not a crash, not a hang), and plain editing/save in the same session "
      "worked correctly and unaffected")
