#!/usr/bin/env python3
"""Prove editor.lsp.display-inlay-hints requests and renders versioned LSP hints."""
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
HINTS = re.compile(rb"XI_LSP_INLAY_HINTS (\{[^\r\n]*\})")
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
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {"positionEncoding": "utf-16", "textDocumentSync": 1, "inlayHintProvider": True}}})
    elif method == "textDocument/inlayHint":
        send({"jsonrpc": "2.0", "id": message["id"], "result": [{"position": {"line": 0, "character": 5}, "label": ":number"}]})
    elif method == "exit":
        break
    elif "id" in message:
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
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


with tempfile.TemporaryDirectory(prefix="xi-config-inlay-hints-pty-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    config = workspace / "config.toml"
    config.write_text("schema-version = 1\n[editor.lsp]\ndisplay-inlay-hints = true\ninlay-hints-length-limit = 4\n", encoding="utf-8")
    source = workspace / "main.ts"
    source.write_text("const value: number = 1;\n", encoding="utf-8")
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
        deadline = time.monotonic() + 15
        while not HINTS.search(captured) and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        matches = [json.loads(match.group(1)) for match in HINTS.finditer(captured)]
        if not matches or matches[-1].get("count") != 1 or matches[-1].get("labels") != [":num"]:
            raise SystemExit(f"production inlay hints were not requested/rendered with the length limit: {matches!r}; output={captured[-7000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")

print("T036 production PTY passed: editor.lsp.display-inlay-hints rendered a length-limited LSP hint.")
