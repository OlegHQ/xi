#!/usr/bin/env python3
"""Prove an editor.gutters array changes the launched editor's gutter geometry."""
from __future__ import annotations

import fcntl
import os
import pty
import runpy
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"Missing gutter output {marker!r}: {captured[-4000:]!r}")


def run_case(root: Path, config_text: str, label: str, diagnostics: bool = False) -> None:
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(config_text, encoding="utf-8")
    source = root / f"gutters-{label}.{'ts' if diagnostics else 'txt'}"
    source.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    if diagnostics:
        fake_bin = root / 'bin'
        fake_bin.mkdir(exist_ok=True)
        server = fake_bin / 'typescript-language-server'
        protocol = runpy.run_path(str(ROOT / 'tests/support/lsp-ready-pty.py'))['SERVER']
        notification = """    if message.get("method") == "textDocument/didOpen":
        document = message["params"]["textDocument"]
        items = [{"range": {"start": {"line": line, "character": 0}, "end": {"line": line, "character": 1}}, "severity": severity, "message": "gutter-test"} for line, severity in ((1, 1), (2, 2))]
        body = json.dumps({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": document["uri"], "version": document["version"], "diagnostics": items}}).encode()
        sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
        sys.stdout.buffer.flush()
"""
        server.write_text(protocol.replace('    if message.get("method") == "exit":', notification + '    if message.get("method") == "exit":'))
        server.chmod(0o700)
        environment['PATH'] = str(fake_bin) + os.pathsep + environment['PATH']
        environment['XI_UI_TEST_MARKERS'] = '0'
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(source)],
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
        if diagnostics:
            screen = Screen(14, 100)
            consumed = 0
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                read_for(master, captured, .05)
                screen.feed(captured[consumed:])
                consumed = len(captured)
                rows = [screen.row_text(row) for row in range(1, 15)]
                error = next((row for row in rows if 'two' in row), '')
                warning = next((row for row in rows if 'three' in row), '')
                enabled = 'diagnostics' in config_text
                if error and warning and (('●' in error and '▲' in warning) if enabled else ('●' not in error and '▲' not in warning)):
                    break
            else:
                raise SystemExit(f"{label}: off-cursor diagnostic icons did not follow gutter config: {rows!r}")
            if any('gutter-test' in row for row in rows):
                raise SystemExit('off-cursor inline messages should remain disabled by default')
        else:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 8)
            wait_for(master, captured, b"  4", 5)
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode} for {label}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-gutters-pty-") as temporary:
    root = Path(temporary)
    run_case(root, 'schema-version = 1\n[editor]\ngutters = ["line-numbers"]\n', "array")
    run_case(root, 'schema-version = 1\n[editor.gutters]\nlayout = ["diff", "diagnostics", "line-numbers"]\n', "layout")
    run_case(root, '[editor.gutters]\nlayout = ["diagnostics", "spacer", "line-numbers"]\n', "icons", True)
    run_case(root, '[editor.gutters]\nlayout = ["line-numbers", "spacer", "diagnostics"]\n', "reordered-icons", True)
    run_case(root, '[editor]\ngutters = ["line-numbers"]\n', "hidden-icons", True)

print("Config gutters PTY passed: launched Xi applied both scalar and table gutter layouts.")
