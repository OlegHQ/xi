#!/usr/bin/env python3
"""Exercise synchronized multi-cursor snippets through the production CLI."""
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
APPLIED = re.compile(rb"XI_COMPLETION_APPLIED (\{[^\r\n]*\})")
SNIPPET = re.compile(rb"XI_SNIPPET_MULTI_(?:OPEN|TAB) (\{[^\r\n]*\})")
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
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))

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


with tempfile.TemporaryDirectory(prefix="xi-t088-snippet-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    source = workspace / "main.ts"
    source.write_text("A\nA\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "TERM": "xterm-256color",
        "HOME": temporary,
        "XI_UI_TEST_MARKERS": "1",
        "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
    })
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
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
        for command in (b":Xi selection.select-all-matches A\r", b":Xi selection.collapse\r"):
            os.write(master, command)
            read_for(master, captured, 0.2)
        os.write(master, b"a\x00")
        read_until(master, captured, b"XI_COMPLETION_OPEN", 5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if any(json.loads(match.group(1)).get("state") == "ready" for match in re.finditer(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})", captured)):
                break
            read_for(master, captured, 0.05)
        os.write(master, b"\x0e\t")
        read_until(master, captured, b"XI_SNIPPET_MULTI_OPEN", 5)
        opened = [json.loads(match.group(1)) for match in SNIPPET.finditer(captured) if b"XI_SNIPPET_MULTI_OPEN" in match.group(0)]
        if not opened or opened[-1].get("members") != 2:
            raise SystemExit(f"snippet did not open for both carets: {opened!r}")
        os.write(master, b"\t!")
        read_until(master, captured, b"XI_SNIPPET_MULTI_TAB", 5)
        tabs = [json.loads(match.group(1)) for match in SNIPPET.finditer(captured) if b"XI_SNIPPET_MULTI_TAB" in match.group(0)]
        if not tabs or tabs[-1].get("members") != 2:
            raise SystemExit(f"snippet Tab did not remain synchronized: {tabs!r}")
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b":wq\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"production multi-snippet did not quit: {captured[-7000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"production multi-snippet exited {child.returncode}: {captured[-5000:]!r}")
    if source.read_text(encoding="utf-8") != "Ax-!\nAx-!\n":
        raise SystemExit(f"synchronized snippet text mismatch: {source.read_text(encoding='utf-8')!r}")
    artifact = ROOT / ".artifacts/e2e/t088-multi-snippet.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({"schema_version": 1, "fixture": "T088-E24-production", "snippet": tabs, "text": source.read_text(encoding="utf-8")}, indent=2) + "\n", encoding="utf-8")

print("T088 production PTY passed multi-cursor completion and synchronized snippet Tab")
