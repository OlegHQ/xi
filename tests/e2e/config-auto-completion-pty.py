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
        send({"jsonrpc":"2.0", "id":message["id"], "result":{"isIncomplete":False, "items":[{"label":"candidate", "filterText":"ab", "insertText":"beta"}]}})
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


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while marker not in captured:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if not select.select([master], [], [], min(0.05, remaining))[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            break
    return marker in captured


def run_case(enabled: bool, replace: bool = False, accept: bool = False, preview: bool = True, cancel_preview: bool = False, supersede_menu: bool = False, focus_preview: bool = False, launch_plain: bool = False, line_below: bool = False) -> list[dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="xi-auto-completion-pty-") as temporary:
        workspace = Path(temporary)
        fake_bin = workspace / "bin"
        fake_bin.mkdir()
        server = fake_bin / "typescript-language-server"
        server.write_text(SERVER, encoding="utf-8")
        server.chmod(stat.S_IRWXU)
        config = workspace / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(f"schema-version = 1\n[editor]\nauto-completion = {'true' if enabled else 'false'}\nauto-format = false\ncompletion-timeout = 250\ncompletion-trigger-len = 2\npreview-completion-insert = {'true' if preview else 'false'}\ncompletion-replace = {'true' if replace else 'false'}\n[editor.smart-tab]\nsupersede-menu = {'true' if supersede_menu else 'false'}\n" + ("[editor.auto-save]\nfocus-lost = true\n" if focus_preview else ""), encoding="utf-8")
        source = workspace / "main.ts"
        plain = workspace / "notes.txt"
        plain.write_text("notes\n", encoding="utf-8")
        (workspace / "package.json").write_text("{}\n", encoding="utf-8")
        source.write_text("x\n" if accept else "a\n", encoding="utf-8")
        master, slave = pty.openpty()
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(workspace / ".config"), "XI_UI_TEST_MARKERS": "1", "PATH": f"{fake_bin}:{environment.get('PATH', '')}"})
        child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(plain if launch_plain else source)], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        captured = bytearray()
        try:
            if not read_until(master, captured, b"XI_WORKBENCH_READY", 30):
                raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")
            if launch_plain:
                os.write(master, b":e main.ts\r")
            if not read_until(master, captured, b"XI_LANGUAGE_STARTED", 15):
                raise SystemExit(f"Xi did not start the TypeScript language server: {captured[-4000:]!r}")
            if not read_until(master, captured, b"XI_LSP_READY", 15):
                raise SystemExit(f"TypeScript language server did not become ready: {captured[-4000:]!r}")
            if line_below:
                os.write(master, b"Go")
                read_for(master, captured, 0.01)
            else:
                os.write(master, b"i")
            if line_below:
                for letter in b"abcd":
                    os.write(master, bytes([letter]))
                    read_for(master, captured, 0.01)
            else:
                os.write(master, b"ab")
            read_for(master, captured, 0.05)
            early_matches = [match.group(1) for match in OPEN.finditer(captured)]
            if enabled and any(b'"trigger":"character"' in value for value in early_matches):
                raise SystemExit(f"completion-timeout did not delay automatic completion: {captured[-4000:]!r}")
            if enabled:
                if not read_until(master, captured, b'"trigger":"character"', 2):
                    raise SystemExit(f"automatic completion did not open at the configured trigger length: {captured[-4000:]!r}")
                if accept or cancel_preview:
                    if not read_until(master, captured, b'XI_COMPLETION_STATE {"state":"ready"', 5):
                        raise SystemExit(f"completion provider did not return its item before the input action: {captured[-4000:]!r}")
            else:
                # The disabled case has no positive marker to await. Let the configured
                # 250 ms completion timeout plus a small scheduling margin elapse.
                read_for(master, captured, 0.30)
            matches = [match.group(1) for match in OPEN.finditer(captured)]
            if enabled and not any(b'"trigger":"character"' in value for value in matches):
                raise SystemExit(f"automatic completion did not open at the configured trigger length: {captured[-4000:]!r}")
            if line_below and b"No language server available" in captured:
                raise SystemExit("typing an identifier showed a stale no-server completion popup")
            if not enabled and matches:
                raise SystemExit(f"disabled automatic completion opened unexpectedly: {captured[-4000:]!r}")
            if cancel_preview:
                os.write(master, b"\x0e")
                if preview:
                    read_until(master, captured, b"XI_COMPLETION_PREVIEW", 2)
                else:
                    read_for(master, captured, 0.02)
                if preview and not PREVIEW.search(captured):
                    raise SystemExit(f"completion preview did not apply on selection: {captured[-4000:]!r}")
                if focus_preview:
                    os.write(master, b"\x1b[O")
                    read_until(master, captured, b'XI_AUTO_SAVE_FOCUS {"focused":false,"enabled":true}', 2)
                    if b'XI_AUTO_SAVE_FOCUS {"focused":false,"enabled":true}' not in captured or source.read_text(encoding="utf-8") != "a\n":
                        raise SystemExit(f"focus-loss persisted tentative completion text: {source.read_text(encoding='utf-8')!r}; {captured[-4000:]!r}")
                os.write(master, b"\x1b")
                read_until(master, captured, b"XI_COMPLETION_CLOSED", 1)
                read_for(master, captured, 0.5)
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b":wq\r")
            elif accept:
                os.write(master, b"\x0e\t" if supersede_menu else b"\x0e\r")
                read_until(master, captured, b"XI_COMPLETION_CLOSED" if supersede_menu else b"XI_COMPLETION_APPLIED", 2)
                if supersede_menu and b"XI_COMPLETION_APPLIED" in captured:
                    raise SystemExit(f"smart-tab supersede-menu accepted a completion unexpectedly: {captured[-4000:]!r}")
                os.write(master, b"\x1b")
                read_until(master, captured, b"XI_COMPLETION_CLOSED", 1)
                read_for(master, captured, 0.5)
                os.write(master, b"\x1b")
                read_for(master, captured, 0.5)
                os.write(master, b":wq\r")
            else:
                os.write(master, b"\x1b")
                read_for(master, captured, 0.1)
                os.write(master, b"\x1b")
                read_for(master, captured, 0.1)
                os.write(master, b":qa!\r" if launch_plain else b":q!\r")
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                read_for(master, captured, 0.05)
            if child.poll() is None:
                raise SystemExit(f"Xi did not quit after completion test: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        if child.returncode != 0:
            raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")
        if accept:
            expected = "ab  x\n" if supersede_menu else ("beta\n" if replace else "betax\n")
            if source.read_text(encoding="utf-8") != expected:
                raise SystemExit(f"completion-replace={replace} produced unexpected text: {source.read_text(encoding='utf-8')!r}")
        if cancel_preview and source.read_text(encoding="utf-8") != "aba\n":
            raise SystemExit(f"cancelled completion preview changed the saved text: {source.read_text(encoding='utf-8')!r}")
        return [{"trigger": "character"} for value in matches if b'"trigger":"character"' in value]


enabled_matches = run_case(True)
run_case(True, line_below=True)
run_case(True, launch_plain=True)
disabled_matches = run_case(False)
run_case(True, replace=False, accept=True)
run_case(True, replace=True, accept=True)
run_case(True, accept=True, supersede_menu=True)
run_case(True, cancel_preview=True, focus_preview=True)
run_case(True, cancel_preview=True, preview=False)
if not enabled_matches or disabled_matches:
    raise SystemExit("automatic completion gate cases did not diverge")
with tempfile.TemporaryDirectory(prefix="xi-ruby-no-server-") as temporary:
    workspace = Path(temporary)
    source = workspace / "sample.rb"
    source.write_text("", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(workspace / ".config"), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    try:
        if not read_until(master, captured, b"XI_WORKBENCH_READY", 15):
            raise SystemExit("Ruby no-server fixture did not reach the workbench")
        os.write(master, b"iabcdef")
        read_for(master, captured, 0.8)
        if b"No language server available" in captured or b'XI_COMPLETION_STATE {"state":"unavailable"' in captured:
            raise SystemExit(f"typing Ruby showed a no-server completion popup: {captured[-4000:]!r}")
    finally:
        child.kill()
        child.wait()
        os.close(master)
print("Config automatic-completion PTY passed: configured identifier trigger opens character completion and false gates it.")
