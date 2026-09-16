#!/usr/bin/env python3
"""Run the production launcher split/close journey under a real kernel PTY."""
from __future__ import annotations

import json
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
artifact_dir = root / ".artifacts" / "e2e"
artifact_dir.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="xi-t038-pty-") as temporary:
    path = Path(temporary) / "shared.txt"
    path.write_text("alpha\nbeta\n", encoding="utf-8")
    transcript = bytearray()
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    process = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(path)],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)

    def read_for(seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            transcript.extend(chunk)

    resized = False
    try:
        read_for(10)
        if b"XI_WORKBENCH_READY" not in transcript:
            raise SystemExit("T038 production PTY did not reach the workbench")
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 40, 0, 0))
        read_for(0.5)
        resized = process.poll() is None
        os.write(master, b":vsplit\r")
        read_for(1)
        if b"XI_WORKBENCH_SPLIT" not in transcript:
            raise SystemExit("T038 production PTY did not create a split")
        os.write(master, b"iX\x1b")
        read_for(1)
        os.write(master, b":q!\r")
        read_for(1)
        if b"XI_WORKBENCH_VIEW_CLOSED" not in transcript:
            raise SystemExit("T038 production PTY did not close the split view")
        os.write(master, b":wq\r")
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
    text = transcript.decode("utf-8", errors="replace")
    markers = {
        "ready": "XI_WORKBENCH_READY" in text,
        "split": "XI_WORKBENCH_SPLIT" in text,
        "close": "XI_WORKBENCH_VIEW_CLOSED" in text,
        "exitCode": process.returncode,
        "resizedWithoutExit": resized,
    }
    (artifact_dir / "t038-pty-transcript.ansi").write_bytes(transcript)
    (artifact_dir / "t038-pty.json").write_text(json.dumps(markers, indent=2) + "\n", encoding="utf-8")
    if process.returncode != 0 or not markers["ready"] or not markers["split"] or not markers["close"] or not markers["resizedWithoutExit"] or path.read_text(encoding="utf-8") != "Xalpha\nbeta\n":
        print("T038 production PTY failed", markers, file=sys.stderr)
        print(text, file=sys.stderr)
        sys.exit(1)
print(f"T038 production PTY passed split/close/edit/save, exit={process.returncode}, bytes={len(transcript)}")
