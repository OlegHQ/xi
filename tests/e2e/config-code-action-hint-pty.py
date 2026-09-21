#!/usr/bin/env python3
"""Prove code-action-hint drives both the statusline and gutter from a real LSP peer."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
HINTS = re.compile(rb"XI_CODE_ACTION_HINT_STATE (\{[^\r\n]*\})")
SERVER = r'''#!/usr/bin/env python3
import json
import sys

def read_message():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, _, value = line.partition(b":")
        if key.lower() == b"content-length":
            length = int(value.strip())
    if length is None:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

def send(message):
    body = json.dumps(message, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {"positionEncoding": "utf-16", "textDocumentSync": 1, "codeActionProvider": True}}})
    elif method == "textDocument/codeAction":
        send({"jsonrpc": "2.0", "id": message["id"], "result": [{"title": "Fix value", "kind": "quickfix"}]})
    elif method == "exit":
        break
    elif "id" in message:
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
'''

def read_for(master: int, stderr: int, captured: bytearray, diagnostics: bytearray, screen: Screen, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for descriptor in select.select([master, stderr], [], [], 0.05)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                continue
            if descriptor == master:
                captured.extend(data)
                screen.feed(data)
            else:
                diagnostics.extend(data)


with tempfile.TemporaryDirectory(prefix="xi-config-code-action-hint-pty-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    config = workspace / "config.toml"
    config.write_text("schema-version = 1\n[editor]\ngutters = [\"code-action-hint\"]\n[editor.statusline]\nleft = [\"code-action-hint\"]\n", encoding="utf-8")
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1", "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "--config", str(config), str(source)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    diagnostics = bytearray()
    screen = Screen(24, 80)
    assert child.stderr is not None
    try:
        deadline = time.monotonic() + 15
        while (not HINTS.search(diagnostics) or "C:1" not in screen.row_text(24) or not screen.row_text(1).startswith("Cconst")) and time.monotonic() < deadline:
            read_for(master, child.stderr.fileno(), captured, diagnostics, screen, 0.05)
        matches = [json.loads(match.group(1)) for match in HINTS.finditer(diagnostics)]
        if not matches or matches[-1].get("count") != 1 or "C:1" not in screen.row_text(24) or not screen.row_text(1).startswith("Cconst"):
            raise SystemExit(f"production code-action hints were not requested/rendered: {matches!r}; status={screen.row_text(24)!r}; row={screen.row_text(1)!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")

print("T036 production PTY passed: code-action-hint rendered the LSP action count in the statusline and gutter.")
