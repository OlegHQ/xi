#!/usr/bin/env python3
"""Prove the embedded Tree-sitter runtime/grammar wasm work inside the compiled binary.

Builds the shipping executable with `bun run package:build`, opens a small real .ts fixture
in an isolated PTY (empty HOME/PATH, so no source-tree or system dependency can leak in), and
waits for an XI_SYNTAX_STATE marker reporting a highlighted parse with classified spans -- the
grammar and runtime wasm files that `bun build --compile` embeds via `type: "file"` imports
(apps/xi/src/syntax-assets.ts) must actually be reachable from inside the standalone binary,
not just from the source checkout's node_modules.
"""
from __future__ import annotations

import errno
import fcntl
import json
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


def read_until(fd: int, needle: bytes, deadline: float, captured: bytearray) -> bool:
    while time.monotonic() < deadline:
        if needle in captured:
            return True
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
    return needle in captured


def parse_syntax_state_markers(captured: bytes) -> list[dict]:
    markers: list[dict] = []
    for line in captured.split(b"\r\n"):
        if not line.startswith(b"XI_SYNTAX_STATE "):
            continue
        payload = line[len(b"XI_SYNTAX_STATE "):]
        try:
            markers.append(json.loads(payload.decode("utf-8", errors="replace")))
        except json.JSONDecodeError:
            continue
    return markers


def main() -> None:
    build = subprocess.run(
        ["bun", "run", "package:build"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        raise SystemExit(f"T053 package:build failed: {build.stdout}{build.stderr}")
    binary = ROOT / "dist" / "xi"
    if not binary.is_file():
        raise SystemExit("T053 package:build did not produce dist/xi")

    with tempfile.TemporaryDirectory(prefix="xi-t053-syntax-pty-") as temporary:
        isolated = Path(temporary)
        home = isolated / "home"
        empty_path = isolated / "empty-bin"
        source = isolated / "fixture.ts"
        home.mkdir()
        empty_path.mkdir()
        source.write_text(
            "const value = 1;\nfunction greet(name: string): string {\n  return \"hi \" + name;\n}\n",
            encoding="utf-8",
        )

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

        master, slave = pty.openpty()
        resize(slave)
        child = subprocess.Popen(
            [str(binary), str(source)],
            cwd=str(isolated),
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
        os.close(slave)
        try:
            captured = bytearray()
            ready = read_until(master, b"XI_WORKBENCH_READY", time.monotonic() + 15, captured)
            if not ready:
                raise SystemExit(f"T053 compiled binary did not become ready: bytes={len(captured)}")

            highlighted = False
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not highlighted:
                for entry in parse_syntax_state_markers(bytes(captured)):
                    if entry.get("status") == "highlighted" and entry.get("spanCount", 0) > 0:
                        highlighted = True
                        break
                if highlighted:
                    break
                readable, _, _ = select.select([master], [], [], 0.1)
                if not readable:
                    continue
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                captured.extend(chunk)
            markers = parse_syntax_state_markers(bytes(captured))
            if not highlighted:
                raise SystemExit(
                    f"T053 compiled binary never reported a highlighted, non-empty XI_SYNTAX_STATE "
                    f"(markers seen: {markers})"
                )

            os.write(master, b":q\r")
            exit_deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < exit_deadline:
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
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                    raise SystemExit("T053 compiled binary did not shut down after :q")
            if child.returncode != 0:
                raise SystemExit(f"T053 compiled binary exited with {child.returncode}")
            print(
                f"T053 compiled-binary syntax PTY passed: embedded runtime/grammar wasm loaded, "
                f"highlighted markers={len(markers)} last={markers[-1] if markers else None}"
            )
        finally:
            os.close(master)
            if child.poll() is None:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
