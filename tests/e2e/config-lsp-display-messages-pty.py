#!/usr/bin/env python3
"""Prove configured LSP window messages and progress reach Xi's status-message owner."""
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
MESSAGE = re.compile(rb"XI_LSP_MESSAGE (\{[^\r\n]*\})")
PROGRESS = re.compile(rb"XI_LSP_PROGRESS (\{[^\r\n]*\})")
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
def send(value):
    body = json.dumps(value, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()
while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"capabilities":{"positionEncoding":"utf-16", "textDocumentSync":1}}})
    elif method == "initialized":
        send({"jsonrpc":"2.0", "method":"window/showMessage", "params":{"type":3, "message":"configured message"}})
        send({"jsonrpc":"2.0", "method":"$/progress", "params":{"token":"demo", "value":{"kind":"begin", "title":"Indexing", "message":"configured progress", "percentage":25}}})
    elif method == "exit":
        break
    elif "id" in message:
        send({"jsonrpc":"2.0", "id":message["id"], "result":None})
'''


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


with tempfile.TemporaryDirectory(prefix="xi-lsp-display-messages-pty-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.lsp]\ndisplay-messages = true\ndisplay-progress-messages = true\n", encoding="utf-8")
    source = workspace / "main.ts"
    source.write_text("const value = 1;\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1", "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_for(master, captured, 10)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
        deadline = time.monotonic() + 10
        while (not MESSAGE.search(captured) or not PROGRESS.search(captured)) and time.monotonic() < deadline:
            read_for(master, captured, 0.1)
        messages = [json.loads(match.group(1)) for match in MESSAGE.finditer(captured)]
        progress = [json.loads(match.group(1)) for match in PROGRESS.finditer(captured)]
        if not any(item.get("message") == "configured message" for item in messages):
            raise SystemExit(f"configured LSP window message was not displayed: {captured[-4000:]!r}")
        if not any(item.get("message") == "configured progress" for item in progress):
            raise SystemExit(f"configured LSP progress message was not displayed: {captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")

print("Config LSP display-message PTY passed: window/showMessage and $/progress reached transient status messages.")
