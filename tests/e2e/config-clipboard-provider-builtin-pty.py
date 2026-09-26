#!/usr/bin/env python3
"""Prove a named Helix built-in clipboard provider reaches its argv process path."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

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


with tempfile.TemporaryDirectory(prefix="xi-builtin-clipboard-pty-") as temporary:
    workspace = Path(temporary)
    source = workspace / "main.txt"
    source.write_text("one\ntwo", encoding="utf-8")
    clipboard = workspace / "clipboard.txt"
    primary = workspace / "primary.txt"
    log = workspace / "xsel.log"
    clipboard.write_text("CLIPBOARD", encoding="utf-8")
    primary.write_text("PRIMARY", encoding="utf-8")
    fake_bin = workspace / "bin"
    fake_bin.mkdir()
    fake_xsel = fake_bin / "xsel"
    fake_xsel.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, sys\n"
        "pathlib.Path(os.environ['XI_TEST_XSEL_LOG']).open('a', encoding='utf-8').write(repr(sys.argv) + '\\n')\n"
        "target = pathlib.Path(os.environ['XI_TEST_PRIMARY'] if '-b' not in sys.argv else os.environ['XI_TEST_CLIPBOARD'])\n"
        "if '-o' in sys.argv: sys.stdout.write(target.read_text(encoding='utf-8'))\n"
        "else: target.write_text(sys.stdin.read(), encoding='utf-8')\n",
        encoding="utf-8",
    )
    fake_xsel.chmod(0o755)
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nclipboard-provider = "x-sel"\n', encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "HOME": temporary,
        "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
        "TERM": "xterm-256color",
        "XI_UI_TEST_MARKERS": "1",
        "XI_TEST_CLIPBOARD": str(clipboard),
        "XI_TEST_PRIMARY": str(primary),
        "XI_TEST_XSEL_LOG": str(log),
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
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"Xi did not reach the workbench: {captured[-4000:]!r}")

        os.write(master, b'"+yy')
        deadline = time.monotonic() + 5
        while clipboard.read_text(encoding="utf-8") != "one\n" and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if clipboard.read_text(encoding="utf-8") != "one\n":
            raise SystemExit(f"x-sel clipboard yank did not reach the provider: value={clipboard.read_text(encoding='utf-8')!r} log={log.read_text(encoding='utf-8') if log.exists() else 'missing'} output={captured[-5000:]!r}")

        os.write(master, b'gg"*yy')
        deadline = time.monotonic() + 5
        while primary.read_text(encoding="utf-8") != "one\n" and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if primary.read_text(encoding="utf-8") != "one\n":
            raise SystemExit(f"x-sel primary yank did not reach the provider: {captured[-5000:]!r}")

        primary.write_text("PRIMARY", encoding="utf-8")
        os.write(master, b'j"+p')
        read_for(master, captured, 0.5)
        os.write(master, b'gg"*p')
        read_for(master, captured, 0.5)
        os.write(master, b"\x1b:wq\r")
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
        if child.poll() is None:
            raise SystemExit(f"Xi did not exit after :wq: {captured[-4000:]!r}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-5000:]!r}")
    result = source.read_text(encoding="utf-8")
    # Pinned Neovim: EOF linewise put lands at column zero; gg preserves it,
    # so characterwise p inserts PRIMARY after the first character of one.
    if result != "oPRIMARYne\ntwo\none\n":
        raise SystemExit(f"x-sel clipboard paste did not reach the document: {result!r}")

print("T036 builtin clipboard-provider PTY passed: x-sel argv semantics reached clipboard and primary registers.")
