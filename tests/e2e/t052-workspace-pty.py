#!/usr/bin/env python3
"""Exercise native LSP rename through the launched editor and disk persistence."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            break
    if marker not in captured:
        raise SystemExit(f"missing marker {marker!r}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t052-workspace-") as temporary:
    workspace = Path(temporary)
    (workspace / "package.json").write_text("{}\n", encoding="utf-8")
    (workspace / "tsconfig.json").write_text('{"compilerOptions":{"strict":true},"include":["*.ts"]}\n', encoding="utf-8")
    target = workspace / "main.ts"
    target.write_text("export const value = 1;\nconsole.log(value);\n", encoding="utf-8")
    closed_target = workspace / "use.ts"
    closed_target.write_text("import { value } from './main';\nconsole.log(value);\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        os.write(master, b"0lllllllllllll")
        time.sleep(0.15)
        # Dirty the open source buffer before the server request. The edit
        # must use that in-memory version while also updating the closed file.
        os.write(master, b"i ")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"l")
        time.sleep(0.1)
        os.write(master, b":xi rename renamed\r")
        wait_for(master, captured, b"XI_RENAME_APPLIED", 15)
        if b'XI_RENAME_PREPARE_SKIPPED {"reason":"unsupported"}' not in captured:
            raise AssertionError(f"expected optional prepareRename to be skipped for this server: {captured!r}")
        os.write(master, b":wq\r")
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"rename exited {child.returncode}: {captured[-8000:]!r}")
    expected = "export const  renamed = 1;\nconsole.log(renamed);\n"
    if target.read_text(encoding="utf-8") != expected:
        raise SystemExit(f"rename saved unexpected bytes: {target.read_bytes()!r}")
    closed_expected = "import { renamed } from './main';\nconsole.log(renamed);\n"
    if closed_target.read_text(encoding="utf-8") != closed_expected:
        raise SystemExit(f"closed rename saved unexpected bytes: {closed_target.read_bytes()!r}; trace={captured[-4000:]!r}")

print("T052 production PTY passed negotiated rename fallback, open/closed workspace edit apply and saved rename")
