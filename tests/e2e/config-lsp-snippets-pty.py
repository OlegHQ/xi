#!/usr/bin/env python3
"""Prove editor.lsp.snippets changes completion behavior in the launched CLI."""
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

ROOT = Path(__file__).resolve().parents[2]
STATE = re.compile(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})")
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
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {"positionEncoding": "utf-16", "textDocumentSync": 1, "completionProvider": {"triggerCharacters": ["."]}}}})
    elif method == "textDocument/completion":
        position = message["params"]["position"]
        line = int(position["line"])
        character = int(position["character"])
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"isIncomplete": False, "items": [{"label": "snippet", "insertTextFormat": 2, "textEdit": {"range": {"start": {"line": line, "character": character}, "end": {"line": line, "character": character}}, "newText": "${1:x}-$0"}}]}})
    elif method == "exit":
        break
    elif "id" in message:
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
'''


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


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-5000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-config-snippets-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    config = workspace / "config.toml"
    config.write_text("schema-version = 1\n[editor.lsp]\nsnippets = false\n", encoding="utf-8")
    source = workspace / "main.ts"
    source.write_text("A\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1", "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "--config", str(config), str(source)],
        cwd=ROOT,
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
        read_until(master, captured, b"XI_LANGUAGE_STARTED", 10)
        read_for(master, captured, 1.0)
        os.write(master, b"a\x00")
        read_until(master, captured, b"XI_COMPLETION_OPEN", 5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
            if any(state.get("state") == "idle" and state.get("items") == 0 for state in states):
                break
            read_for(master, captured, 0.05)
        states = [json.loads(match.group(1)) for match in STATE.finditer(captured)]
        if not states or states[-1].get("items") != 0 or states[-1].get("state") not in ("ready", "idle"):
            raise SystemExit(f"snippet completion was not filtered: {states!r}; output={captured[-5000:]!r}")
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":q\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"production snippets config did not quit: {captured[-7000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production snippets config exited {child.returncode}: {captured[-5000:]!r}")

print("T036 production PTY passed: editor.lsp.snippets=false filtered snippet-format completion")
