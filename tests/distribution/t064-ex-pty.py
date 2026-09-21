#!/usr/bin/env python3
"""Exercise native Ex write/quit behavior through a packaged binary PTY."""
from __future__ import annotations

import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[2]


def resize(fd: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))


def read_until(fd: int, marker: bytes, deadline: float) -> bytearray:
    captured = bytearray()
    while time.monotonic() < deadline and marker not in captured:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        captured.extend(chunk)
    return captured


def drain(fd: int, captured: bytearray, deadline: float) -> None:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if chunk:
            captured.extend(chunk)


def launch(binary: Path, source: Path, environment: dict[str, str], keys: bytes, require_alive_after: bytes | None = None) -> bytearray:
    master, slave = pty.openpty()
    resize(slave)
    child = subprocess.Popen(
        [str(binary), f"{source}:2"],
        cwd=binary.parent,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    try:
        captured = read_until(master, b"XI_WORKBENCH_READY", time.monotonic() + 15)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"T064 Ex PTY did not become ready: bytes={len(captured)}")
        for key in keys:
            os.write(master, bytes([key]))
            time.sleep(0.05)
        time.sleep(0.25)
        drain(master, captured, time.monotonic() + 0.25)
        if require_alive_after is not None:
            if child.poll() is not None:
                raise SystemExit(f"T064 Ex command unexpectedly exited after {require_alive_after!r}: status={child.returncode}")
        else:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                raise SystemExit("T064 Ex PTY did not shut down")
            if child.returncode != 0:
                raise SystemExit(f"T064 Ex PTY exited with {child.returncode}")
            # OpenTUI can flush its final terminal-reset bytes as the process exits; reap
            # before the last bounded read so the assertion sees the complete transcript.
            drain(master, captured, time.monotonic() + 0.25)
        return captured
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
            child.wait()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t064-ex-") as temporary:
        isolated = Path(temporary)
        binary = isolated / "xi"
        home = isolated / "home"
        empty_path = isolated / "empty-bin"
        source = isolated / "sample.txt"
        home.mkdir()
        empty_path.mkdir()
        source.write_text("first line\nsecond line\n", encoding="utf-8")
        build = subprocess.run(
            ["bun", "run", "package:build"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            raise SystemExit(f"T064 Ex compiled build failed: {build.stdout}{build.stderr}")
        shutil.copy2(ROOT / "dist" / "xi", binary)
        environment = os.environ.copy()
        environment.update({
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / "config"),
            "PATH": str(empty_path),
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "XI_UI_TEST_MARKERS": "1",
        })

        write_quit = launch(binary, source, environment, b":wq\r")
        if source.read_text(encoding="utf-8") != "first line\nsecond line\n":
            raise SystemExit("T064 Ex :wq changed file bytes unexpectedly")
        if b"\x1b[?1049l" not in write_quit or b"\x1b[?25h" not in write_quit:
            raise SystemExit("T064 Ex :wq did not restore terminal state")

        dirty_quit = launch(binary, source, environment, b"iX\x1b:q\r", require_alive_after=b":q\r")
        if b"unsaved changes" not in dirty_quit:
            raise SystemExit("T064 Ex dirty :q did not report the unsaved-change refusal")
        forced_quit = launch(binary, source, environment, b"iX\x1b:q!\r")
        if b"\x1b[?1049l" not in forced_quit or b"\x1b[?25h" not in forced_quit:
            raise SystemExit("T064 Ex :q! did not restore terminal state")
        if source.read_text(encoding="utf-8") != "first line\nsecond line\n":
            raise SystemExit("T064 Ex :q! unexpectedly saved dirty file")
        print("T064 packaged Ex PTY passed :wq, dirty :q refusal, :q! and terminal restoration")


if __name__ == "__main__":
    main()
