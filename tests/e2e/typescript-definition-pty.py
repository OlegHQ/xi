#!/usr/bin/env python3
"""Exercise TypeScript definition navigation through the launched Xi editor."""
import fcntl
import argparse
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path)
args = parser.parse_args()
command = [str(args.binary.resolve())] if args.binary is not None else ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts')]
SOURCE = ROOT / "apps/xi/src/main.ts"
LINES = SOURCE.read_text().splitlines()
REFERENCE = next(index for index, line in enumerate(LINES) if "const coreServices = await coreServicesModule" in line)
DECLARATION = next(index for index, line in enumerate(LINES) if "const coreServicesModule = import(" in line)

with tempfile.TemporaryDirectory(prefix="xi-typescript-definition-") as home:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_"))}
    env.update(HOME=home, XDG_CONFIG_HOME="", TERM="xterm-256color", XI_UI_TEST_MARKERS="1")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    child = subprocess.Popen([*command, str(SOURCE)], cwd=ROOT,
                             env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE)
    os.close(slave)
    assert child.stderr is not None
    screen = Screen(40, 120)
    diagnostics = bytearray()
    original = SOURCE.read_bytes()

    def pump() -> None:
        for descriptor in select.select([master, child.stderr.fileno()], [], [], .005)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                data = b""
            if descriptor == master:
                screen.feed(data)
            else:
                diagnostics.extend(data)

    def wait_for(predicate, seconds: float = 10) -> None:
        deadline = time.monotonic() + seconds
        while not predicate() and time.monotonic() < deadline:
            pump()
        if not predicate():
            raise AssertionError(f"TypeScript PTY timed out: {diagnostics[-800:]!r}\n" + "\n".join(repr(screen.row_text(row)) for row in range(1, 41)))

    def events(name: bytes) -> list[dict]:
        return [json.loads(match) for match in re.findall(rb"XI_" + name + rb" (\{[^\r\n]*\})", diagnostics)]

    try:
        wait_for(lambda: b"XI_LSP_READY" in diagnostics)
        os.write(master, f"{REFERENCE + 1}G".encode())
        time.sleep(.1)
        os.write(master, b"fM")
        time.sleep(.05)
        os.write(master, b"gd")
        wait_for(lambda: len(events(b"NATIVE_JUMP")) >= 1)
        assert events(b"NATIVE_JUMP")[-1]["line"] == DECLARATION
        wait_for(lambda: any("const coreServicesModule = import(" in screen.row_text(row) for row in range(1, 41)))
        os.write(master, b":xi references\r")
        wait_for(lambda: len(events(b"NATIVE_JUMP")) >= 2)
        assert events(b"REFERENCES_REQUEST")[-1]["count"] >= 2
        assert events(b"NATIVE_JUMP")[-1]["line"] == REFERENCE
        os.write(master, b"a\x00")
        wait_for(lambda: any(event.get("state") == "ready" and event.get("items", 0) > 0 for event in events(b"COMPLETION_STATE")))
    finally:
        child.kill()
        child.wait()
        os.close(master)
    assert SOURCE.read_bytes() == original

print("TypeScript PTY passed definition, visible jump, references and completion")
