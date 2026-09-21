#!/usr/bin/env python3
"""Prove master [theme] dark/light/fallback selection through a real terminal."""
from __future__ import annotations

import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DARK_BACKGROUND = b"\x1b[48;2;30;30;46m"
LIGHT_BACKGROUND = b"\x1b[48;2;252;252;250m"
THEME_QUERY = b"\x1b]10;?\x07"


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def run_case(root: Path, response: bytes | None, expected: bytes, fallback: str) -> None:
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(
        "[theme]\ndark = \"xi-dark\"\nlight = \"xi-light\"\n"
        f"fallback = \"{fallback}\"\n",
        encoding="utf-8",
    )
    source = root / "theme-variants.txt"
    source.write_text("theme variants\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"HOME": str(root), "TERM": "xterm-256color", "COLORTERM": "truecolor", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), source.name],
        cwd=root,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    responded_queries = 0
    def respond_if_queried() -> None:
        nonlocal responded_queries
        query_count = captured.count(THEME_QUERY)
        if response is not None and query_count > responded_queries:
            os.write(master, b"\x1b]10;rgb:ffff/ffff/ffff\x07" + response)
            responded_queries = query_count
    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
            respond_if_queried()
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start: {captured[-4000:]!r}")
        if response is not None:
            os.write(master, b"\x1b[?997;1n")
        deadline = time.monotonic() + 1.5
        while expected not in captured and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
            respond_if_queried()
        if expected not in captured:
            raise SystemExit(f"theme variant was not painted: expected={expected!r} queries={responded_queries} output={captured[-4000:]!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-theme-variants-pty-") as temporary:
    root = Path(temporary)
    run_case(root / "dark", b"\x1b]11;rgb:0000/0000/0000\x07", DARK_BACKGROUND, "xi-light")
    run_case(root / "light", b"\x1b]11;#ffffff\x07", LIGHT_BACKGROUND, "xi-dark")
    run_case(root / "fallback", None, DARK_BACKGROUND, "xi-dark")

print("Config theme variants PTY passed: terminal dark/light responses selected their themes and no response used fallback.")
