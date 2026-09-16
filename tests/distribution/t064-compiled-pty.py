#!/usr/bin/env python3
"""Exercise a self-contained compiled Xi binary in an isolated PTY.

The child runs with an empty HOME and an empty PATH, so this catches accidental
startup dependence on the source checkout, Neovim, Git, ripgrep or an LSP
executable. OpenTUI must still render and restore the terminal.
"""
from __future__ import annotations

import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[2]


def resize(fd: int, width: int = 80, height: int = 24) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


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


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-t064-") as temporary:
        isolated = Path(temporary)
        binary = isolated / "xi"
        home = isolated / "home"
        empty_path = isolated / "empty-bin"
        source = isolated / "unicode file.txt"
        home.mkdir()
        empty_path.mkdir()
        source.write_text("first line\nsecond 😀 line\n", encoding="utf-8")
        compile_result = subprocess.run(
            ["bun", "build", "--compile", "--bytecode", "--format=esm", "apps/xi/src/main.ts", "--outfile", str(binary)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if compile_result.returncode != 0:
            raise SystemExit(f"T064 compiled build failed: {compile_result.stdout}{compile_result.stderr}")

        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / "config"),
                "PATH": str(empty_path),
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "XI_UI_TEST_MARKERS": "1",
            }
        )
        quit_capture = launch(binary, source, environment, b"q")
        interrupt_capture = launch(binary, source, environment, b"\x03")
        resized_capture = launch(binary, source, environment, b"q", resizes=((60, 18), (120, 40)))
        for label, captured in (("q", quit_capture), ("Ctrl-C", interrupt_capture), ("resize", resized_capture)):
            # The line:2 cursor paints over the first glyph, so the raw PTY
            # transcript may contain `econd` instead of the full word.
            if source.name.encode("utf-8") not in captured or not (b"second" in captured or b"econd" in captured):
                raise SystemExit(f"T064 compiled PTY {label} run did not render file:line content")
            if b"\x1b[?1049l" not in captured or b"\x1b[?25h" not in captured:
                raise SystemExit(f"T064 compiled PTY {label} run did not restore alternate screen/cursor")
        print(f"T064 compiled PTY passed isolated no-Neovim launch, q/Ctrl-C shutdown, resize and terminal restoration; q_bytes={len(quit_capture)} ctrl_c_bytes={len(interrupt_capture)} resize_bytes={len(resized_capture)}")


def launch(binary: Path, source: Path, environment: dict[str, str], key: bytes, resizes: tuple[tuple[int, int], ...] = ()) -> bytearray:
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
            raise SystemExit(f"T064 compiled PTY did not become ready: bytes={len(captured)}")
        for width, height in resizes:
            resize(master, width, height)
            time.sleep(0.15)
            drain(master, captured, time.monotonic() + 0.15)
        os.write(master, key)
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if chunk:
                captured.extend(chunk)
        if child.poll() is None:
            # EIO means the PTY slave closed, but the process may still be in
            # OpenTUI's bounded terminal restoration path. Reap it instead of
            # treating the short race between poll() and exit as a failure.
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                raise SystemExit("T064 compiled PTY did not shut down")
        # Give the renderer a bounded opportunity to flush its cleanup bytes.
        drain_deadline = time.monotonic() + 0.5
        while time.monotonic() < drain_deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if chunk:
                captured.extend(chunk)
        if child.returncode != 0:
            raise SystemExit(f"T064 compiled PTY exited with {child.returncode}")
        return captured
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
            child.wait()


if __name__ == "__main__":
    main()
