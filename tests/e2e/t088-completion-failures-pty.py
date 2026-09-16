#!/usr/bin/env python3
"""Exercise completion topology rejection and the explicit primary-only action."""
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
REJECTED = re.compile(rb"XI_COMPLETION_REJECTED (\{[^\r\n]*\})")
APPLIED = re.compile(rb"XI_COMPLETION_APPLIED (\{[^\r\n]*\})")
SERVER = r'''#!/usr/bin/env python3
import json
import sys
def read_message():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        if line in (b"\r\n", b"\n"): break
        key, _, value = line.partition(b":")
        if key.lower() == b"content-length": length = int(value.strip())
    if length is None: return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
def send(value):
    body = json.dumps(value, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()
while True:
    message = read_message()
    if message is None: break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"capabilities":{"positionEncoding":"utf-16", "textDocumentSync":1, "completionProvider":{}}}})
    elif method == "textDocument/completion":
        position = message["params"]["position"]
        line, character = int(position["line"]), int(position["character"])
        start = max(0, character - 1)
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"isIncomplete":False, "items":[{"label":"x", "insertTextFormat":1, "textEdit":{"range":{"start":{"line":line,"character":start},"end":{"line":line,"character":character}},"newText":"x"}}]}})
    elif method == "exit":
        break
    elif "id" in message:
        send({"jsonrpc":"2.0", "id":message["id"], "result":None})
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


def read_until_ready_count(master: int, captured: bytearray, count: int, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready = [match for match in re.finditer(rb"XI_COMPLETION_STATE (\{[^\r\n]*\})", captured) if json.loads(match.group(1)).get("state") == "ready"]
        if len(ready) >= count:
            return
        read_for(master, captured, 0.05)
    raise SystemExit(f"completion did not reach ready state {count}: {captured[-5000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t088-failure-") as temporary:
    workspace = Path(temporary)
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    server = fake_bin / "typescript-language-server"
    server.write_text(SERVER, encoding="utf-8")
    server.chmod(stat.S_IRWXU)
    source = workspace / "main.ts"
    source.write_text("A\nB\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM":"xterm-256color", "HOME":temporary, "XI_UI_TEST_MARKERS":"1", "PATH":f"{fake_bin}:{environment.get('PATH','')}"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b":Xi selection.add-below\r")
        read_for(master, captured, 0.2)
        os.write(master, b"a\x00")
        read_until(master, captured, b"XI_COMPLETION_OPEN", 5)
        read_until_ready_count(master, captured, 1, 10)
        os.write(master, b"\x0e\t")
        read_until(master, captured, b"XI_COMPLETION_REJECTED", 5)
        os.write(master, b"\x1b")
        time.sleep(0.2)
        os.write(master, b":wq\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"completion failure PTY exited {child.returncode}: {captured[-5000:]!r}")
    if source.read_text(encoding="utf-8") != "A\nB\n":
        raise SystemExit(f"rejected completion changed the document: {source.read_text(encoding='utf-8')!r}")
    artifact = ROOT / ".artifacts/e2e/t088-completion-failures.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    rejected = [json.loads(match.group(1)) for match in REJECTED.finditer(captured)]
    artifact.write_text(json.dumps({"schema_version":1, "fixture":"T088-incompatible-context", "completion":rejected}, indent=2) + "\n", encoding="utf-8")

print("T088 production PTY passed incompatible-context rejection before mutation")
