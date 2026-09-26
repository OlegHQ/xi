#!/usr/bin/env python3
"""Prove editor.editor-config does not gate trusted .helix/config.toml."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


with tempfile.TemporaryDirectory(prefix="xi-editor-config-pty-") as temporary:
    root = Path(temporary)
    (root / ".config" / "xi").mkdir(parents=True)
    (root / ".config" / "xi" / "config.toml").write_text("[editor]\neditor-config = false\n[editor.workspace-trust]\nlevel = \"insecure\"\n", encoding="utf-8")
    (root / ".helix").mkdir()
    (root / ".helix" / "config.toml").write_text("[editor]\nline-number = \"relative\"\n", encoding="utf-8")
    (root / "main.txt").write_text("text\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-3000:]!r}")
        if b'XI_EDITOR_CONFIG {"enabled":false,"lineNumber":"relative"}' not in captured:
            raise SystemExit(f"trusted project config did not load independently of editor-config\n{captured[-4000:]!r}")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {bytes(captured[-4000:])!r}")

print("T036 production PTY passed editor.editor-config")

for enabled in (True, False):
    with tempfile.TemporaryDirectory(prefix="xi-editorconfig-effect-") as temporary:
        root = Path(temporary)
        (root / ".config" / "xi").mkdir(parents=True)
        (root / ".config" / "xi" / "config.toml").write_text(
            f'[editor]\neditor-config = {str(enabled).lower()}\nauto-format = false\n[editor.lsp]\nenable = false\n[editor.workspace-trust]\nlevel = "insecure"\n', encoding="utf-8"
        )
        (root / ".editorconfig").write_text(
            'root = true\n[*.ts]\nindent_style = space\nindent_size = 4\nend_of_line = crlf\n', encoding="utf-8"
        )
        target = root / "main.ts"
        target.write_bytes(b"x\n")
        master, slave = pty.openpty()
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"], cwd=root, env=environment,
            stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        )
        os.close(slave)
        captured = bytearray()
        try:
            deadline = time.monotonic() + 10
            while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
            if b"XI_WORKBENCH_READY" not in captured:
                raise SystemExit(f"EditorConfig workbench did not start: {captured[-2000:]!r}")
            os.write(master, b"i\t")
            time.sleep(0.15)
            os.write(master, b"\x1b")
            time.sleep(0.15)
            os.write(master, b":wq\r")
            deadline = time.monotonic() + 10
            while child.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
            if child.poll() is None and b'XI_TEARDOWN {"step":"done"}' in captured:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            if child.poll() is None:
                raise SystemExit(f"EditorConfig save timed out: {captured[-4000:]!r}")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
        expected = b"    x\r\n" if enabled else b"  x\n"
        # T036-EDITOR-CONFIG-PTY-01: the launched editor applies or ignores .editorconfig.
        if target.read_bytes() != expected:
            raise SystemExit(f"editor-config={enabled}: expected {expected!r}, got {target.read_bytes()!r}; {captured[-2000:]!r}")
        if child.returncode != 0:
            raise SystemExit(f"editor-config={enabled}: Xi exited {child.returncode}")

print("T036 production PTY passed EditorConfig indentation and line ending")
