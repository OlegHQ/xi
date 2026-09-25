#!/usr/bin/env python3
"""Prove configured statusline elements reach the launched editor."""
from __future__ import annotations

import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]


def read_for(master: int, stderr: int, screen: Screen, diagnostics: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for descriptor in select.select([master, stderr], [], [], 0.05)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                continue
            if descriptor == master:
                screen.feed(data)
            else:
                diagnostics.extend(data)


with tempfile.TemporaryDirectory(prefix="xi-statusline-pty-") as temporary:
    root = Path(temporary)
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("schema-version = 1\n[editor.statusline]\nleft = [\"mode\", \"separator\", \"file-base-name\", \"file-encoding\", \"file-indent-style\", \"file-type\", \"primary-selection-length\", \"register\", \"current-working-directory\"]\nseparator = \"~\"\nmode.normal = \"NORMX\"\n", encoding="utf-8")
    (root / ".editorconfig").write_text("root = true\n[statusline.txt]\nindent_style = space\nindent_size = 2\n", encoding="utf-8")
    (config.parent / "languages.toml").write_text('[[language]]\nname = "ruby"\nfile-types = ["rb"]\nlanguage-servers = ["ruby-lsp"]\nindent = { tab-width = 4, unit = "    " }\n', encoding="utf-8")
    source = root / "statusline.txt"
    source.write_text("🙂one\ntwo\n", encoding="utf-8")
    tab_source = root / "tabbed" / "tab.txt"
    tab_source.parent.mkdir()
    (tab_source.parent / ".editorconfig").write_text("root = true\n[*]\nindent_style = tab\n", encoding="utf-8")
    tab_source.write_text("\tother\n", encoding="utf-8")
    plain_source = root / "plain.txt"
    plain_source.write_text("plain\n", encoding="utf-8")
    ruby_source = root / "sample.rb"
    ruby_source.write_text("ruby\n", encoding="utf-8")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
    environment = os.environ.copy()
    environment.update({"HOME": temporary, "XDG_CONFIG_HOME": str(root / ".config"), "TERM": "xterm-256color", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    screen = Screen(14, 100)
    diagnostics = bytearray()
    assert child.stderr is not None
    try:
        read_for(master, child.stderr.fileno(), screen, diagnostics, 8)
        if b"XI_WORKBENCH_READY" not in diagnostics:
            raise SystemExit(f"Xi did not reach the workbench: {diagnostics[-4000:]!r}")
        expected = "NORMX ~ statusline.txt  2 spaces text 1 char"
        if expected not in screen.row_text(14):
            raise SystemExit(f"configured statusline was not rendered: {screen.row_text(14)!r}; diagnostics: {diagnostics[-2000:]!r}")
        os.write(master, b":e tabbed/tab.txt\r")
        deadline = time.monotonic() + 5
        while " tab.txt  tabs " not in screen.row_text(14) and time.monotonic() < deadline:
            read_for(master, child.stderr.fileno(), screen, diagnostics, 0.05)
        if " tab.txt  tabs " not in screen.row_text(14):
            raise SystemExit(f"statusline did not follow the tab-indented buffer: {screen.row_text(14)!r}")
        for name, expected, path, spaces in [("plain.txt", "2 spaces", plain_source, 2), ("sample.rb", "4 spaces", ruby_source, 4)]:
            os.write(master, f":e {name}\r".encode())
            deadline = time.monotonic() + 5
            while f" {name}  {expected} " not in screen.row_text(14) and time.monotonic() < deadline:
                read_for(master, child.stderr.fileno(), screen, diagnostics, 0.05)
            if f" {name}  {expected} " not in screen.row_text(14):
                raise SystemExit(f"indent style for {name} was not rendered: {screen.row_text(14)!r}")
            os.write(master, b"i\t\x1b:w\r")
            deadline = time.monotonic() + 5
            while not path.read_text(encoding="utf-8").startswith(" " * spaces) and time.monotonic() < deadline:
                read_for(master, child.stderr.fileno(), screen, diagnostics, 0.05)
            if not path.read_text(encoding="utf-8").startswith(" " * spaces):
                raise SystemExit(f"Tab did not insert {spaces} spaces in {name}: {path.read_text()!r}")
        os.write(master, b":qa!\r")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {diagnostics[-4000:]!r}")

print("Config statusline PTY passed: launched Xi applied default and language indent, followed EditorConfig, omitted UTF-8 and counted one emoji scalar.")
