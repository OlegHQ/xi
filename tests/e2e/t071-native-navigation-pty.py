#!/usr/bin/env python3
"""Exercise production gf/gF and Ctrl-W gf through a kernel PTY."""
from __future__ import annotations

import json
import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_until(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return
    if marker not in captured:
        raise SystemExit(f"missing PTY marker: {marker!r}\n{captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t071-native-navigation-") as temporary:
    workspace = Path(temporary)
    (workspace / "main.ts").write_text("other.ts:3\nFoo\n", encoding="utf-8")
    (workspace / "other.ts").write_text("one\ntwo\nthree\n", encoding="utf-8")
    (workspace / "tags").write_text("!_TAG_FILE_FORMAT\t2\t/extended format/\nFoo\tother.ts\t3;\"\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"],
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
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b"\x17gf")
        read_until(master, captured, b'"split":true', 5)
        os.write(master, b"\x17w")
        os.write(master, b"gF")
        read_until(master, captured, b'"line":2', 5)
        os.write(master, b"\x17w")
        os.write(master, b"j\x1d")
        read_until(master, captured, b"XI_NATIVE_TAG", 5)
        # gf/Ctrl-W gf/tag-jump can leave more than one view open; bare 'q' now correctly
        # closes one view per press (matching ':q' semantics) instead of quitting the whole
        # app immediately, so close views explicitly via Ex until the process actually exits
        # rather than assuming or relying on stray Normal-mode keystrokes.
        for _ in range(5):
            if child.poll() is not None:
                break
            os.write(master, b":q!\r")
            deadline = time.monotonic() + 1
            while child.poll() is None and time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    text = captured.decode("utf-8", errors="replace")
    markers = {
        "ready": "XI_WORKBENCH_READY" in text,
        "splitJump": '"split":true' in text,
        "lineJump": '"line":2' in text,
        "tagJump": "XI_NATIVE_TAG" in text,
        "exitCode": child.returncode,
    }
    artifact_dir = ROOT / ".artifacts" / "e2e"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "t071-native-navigation.json").write_text(json.dumps(markers, indent=2) + "\n", encoding="utf-8")
    (artifact_dir / "t071-native-navigation.ansi").write_bytes(captured)
    if child.returncode != 0 or not all(markers[key] for key in ("ready", "splitJump", "lineJump", "tagJump")):
        raise SystemExit(f"T071 native navigation PTY failed: {markers}\n{text[-8000:]}")

print("T071 production PTY passed gf/gF location jumps and Ctrl-W gf split navigation")
