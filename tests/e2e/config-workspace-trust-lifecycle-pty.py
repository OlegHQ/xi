#!/usr/bin/env python3
"""A running LSP stops on workspace revocation and restarts after trust is granted."""
from __future__ import annotations

import fcntl
import os
import pty
import select
import stat
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = r'''#!/usr/bin/env python3
import json, os, sys
log = os.environ["XI_FAKE_LSP_LOG"]
with open(log, "a", encoding="utf-8") as out: out.write("start\n")
def read():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        if line in (b"\r\n", b"\n"): break
        if line.lower().startswith(b"content-length:"): length = int(line.split(b":", 1)[1])
    return json.loads(sys.stdin.buffer.read(length)) if length is not None else None
def send(message):
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()
try:
    while (message := read()) is not None:
        if message.get("method") == "exit": break
        if "id" in message:
            result = {"capabilities": {"textDocumentSync": 1}} if message.get("method") == "initialize" else None
            send({"jsonrpc": "2.0", "id": message["id"], "result": result})
finally:
    with open(log, "a", encoding="utf-8") as out: out.write("stop\n")
'''


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                return


def await_lines(path: Path, expected: list[str], master: int, captured: bytearray) -> None:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        if lines == expected:
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"LSP lifecycle {expected!r} not observed: {lines!r}; PTY={captured[-3000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-trust-lsp-pty-") as temporary:
    root = Path(temporary)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    log = root / "lsp.log"
    config = root / "config.toml"
    config.write_text('[editor.workspace-trust]\nlevel = "none"\nprompt = false\n', encoding="utf-8")
    source = root / "main.ts"
    source.write_text("const n = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1", "XI_FAKE_LSP_LOG": str(log), "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "--config", str(config), str(source)], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_for(master, captured, 2)
        if b"XI_WORKBENCH_READY" not in captured or log.exists():
            raise SystemExit(f"restricted startup launched a server or did not start: {captured[-3000:]!r}")
        for command, expected in [(b":workspace-trust\r", ["start"]), (b":workspace-untrust\r", ["start", "stop"]), (b":workspace-trust\r", ["start", "stop", "start"])]:
            os.write(master, command)
            await_lines(log, expected, master, captured)
            if command == b":workspace-untrust\r":
                os.write(master, b"iZ\x1b")
                read_for(master, captured, 0.4)
                if log.read_text(encoding="utf-8").splitlines() != expected:
                    raise SystemExit("editing after trust revocation restarted the language server")
        os.write(master, b":q!\r")
        child.wait(timeout=8)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-3000:]!r}")

print("Workspace trust LSP lifecycle PTY passed: grant, revoke, grant after service initialization")
