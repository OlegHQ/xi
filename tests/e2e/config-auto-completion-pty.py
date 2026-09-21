#!/usr/bin/env python3
"""Prove editor.auto-completion and editor.completion-trigger-len on the production input path."""
from __future__ import annotations

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
OPEN = re.compile(rb"XI_COMPLETION_OPEN (\{[^\r\n]*\})")
PREVIEW = re.compile(rb"XI_COMPLETION_PREVIEW (\{[^\r\n]*\})")
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
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"capabilities":{"positionEncoding":"utf-16", "textDocumentSync":1, "completionProvider":{}}}})
    elif method == "textDocument/completion":
        position = message["params"]["position"]
        line, character = int(position["line"]), int(position["character"])
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"isIncomplete":False, "items":[{"label":"candidate", "insertText":"beta"}]}})
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


def run_case(enabled: bool, replace: bool = False, accept: bool = False, preview: bool = True, cancel_preview: bool = False, supersede_menu: bool = False) -> list[dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="xi-auto-completion-pty-") as temporary:
        workspace = Path(temporary)
        fake_bin = workspace / "bin"
        fake_bin.mkdir()
        server = fake_bin / "typescript-language-server"
        server.write_text(SERVER, encoding="utf-8")
        server.chmod(stat.S_IRWXU)
        config = workspace / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(f"schema-version = 1\n[editor]\nauto-completion = {'true' if enabled else 'false'}\nauto-format = false\ncompletion-timeout = 250\ncompletion-trigger-len = 2\npreview-completion-insert = {'true' if preview else 'false'}\ncompletion-replace = {'true' if replace else 'false'}\n[editor.smart-tab]\nsupersede-menu = {'true' if supersede_menu else 'false'}\n", encoding="utf-8")
        source = workspace / "main.ts"
        (workspace / "package.json").write_text("{}\n", encoding="utf-8")
        source.write_text("x\n" if accept else "a\n", encoding="utf-8")
        master, slave = pty.openpty()
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1", "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            read_for(master, captured, 10)
            if b"XI_WORKBENCH_READY" not in captured:
                raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
            read_for(master, captured, 3)
            if b"XI_LANGUAGE_STARTED" not in captured:
                raise SystemExit(f"Xi did not start the TypeScript language server: {captured[-4000:]!r}")
            os.write(master, b"iab")
            read_for(master, captured, 0.05)
            early_matches = [match.group(1) for match in OPEN.finditer(captured)]
            if enabled and any(b'"trigger":"character"' in value for value in early_matches):
                raise SystemExit(f"completion-timeout did not delay automatic completion: {captured[-4000:]!r}")
            read_for(master, captured, 5)
            matches = [match.group(1) for match in OPEN.finditer(captured)]
            if enabled and not any(b'"trigger":"character"' in value for value in matches):
                raise SystemExit(f"automatic completion did not open at the configured trigger length: {captured[-4000:]!r}")
            if not enabled and matches:
                raise SystemExit(f"disabled automatic completion opened unexpectedly: {captured[-4000:]!r}")
            if cancel_preview:
                os.write(master, b"\x0e")
                read_for(master, captured, 1)
                if preview and not PREVIEW.search(captured):
                    raise SystemExit(f"completion preview did not apply on selection: {captured[-4000:]!r}")
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b":wq\r")
                read_for(master, captured, 1)
            elif accept:
                os.write(master, b"\x0e\t" if supersede_menu else b"\x0e\r")
                read_for(master, captured, 1)
                if supersede_menu and b"XI_COMPLETION_APPLIED" in captured:
                    raise SystemExit(f"smart-tab supersede-menu accepted a completion unexpectedly: {captured[-4000:]!r}")
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b":wq\r")
                read_for(master, captured, 1)
            else:
                os.write(master, b"\x1b")
                time.sleep(0.1)
                os.write(master, b"\x1b")
                time.sleep(0.1)
                os.write(master, b":q!\r")
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise SystemExit(f"Xi did not quit after completion test: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")
        if accept:
            expected = "ab\tx\n" if supersede_menu else ("beta\n" if replace else "abbetax\n")
            if source.read_text(encoding="utf-8") != expected:
                raise SystemExit(f"completion-replace={replace} produced unexpected text: {source.read_text(encoding='utf-8')!r}")
        if cancel_preview and source.read_text(encoding="utf-8") != "aba\n":
            raise SystemExit(f"cancelled completion preview changed the saved text: {source.read_text(encoding='utf-8')!r}")
        return [{"trigger": "character"} for value in matches if b'"trigger":"character"' in value]


enabled_matches = run_case(True)
disabled_matches = run_case(False)
run_case(True, replace=False, accept=True)
run_case(True, replace=True, accept=True)
run_case(True, accept=True, supersede_menu=True)
run_case(True, cancel_preview=True)
run_case(True, cancel_preview=True, preview=False)
if not enabled_matches or disabled_matches:
    raise SystemExit("automatic completion gate cases did not diverge")
print("Config automatic-completion PTY passed: configured identifier trigger opens character completion and false gates it.")
