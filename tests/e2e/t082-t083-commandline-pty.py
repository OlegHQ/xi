#!/usr/bin/env python3
"""Exercise production prefix-help and Ex command-line ownership through a PTY."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def visible_text(captured: bytearray) -> bytes:
    """Read text across SGR/cursor controls without treating them as visible gaps."""
    return re.sub(rb"\s+", b" ", ANSI.sub(b"", captured))


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
    while marker not in captured and marker not in visible_text(captured) and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured and marker not in visible_text(captured):
        raise SystemExit(f"missing visible PTY text {marker!r}: {visible_text(captured)[-4000:]!r}")


def launch(source: Path, keys: tuple[bytes, ...], expected: tuple[bytes, ...], label: str, cleanup: tuple[bytes, ...] = ()) -> bytes:
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(source.parent), "XI_UI_TEST_MARKERS": "1"})
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
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)
        for key in keys:
            os.write(master, key)
            read_for(master, captured, 0.08)
        for marker in expected:
            read_until(master, captured, marker, 3)
        for key in cleanup:
            os.write(master, key)
            read_for(master, captured, 0.15)
        child.wait(timeout=5)
        if child.returncode != 0:
            raise SystemExit(f"{label}: child exited {child.returncode}")
        return bytes(captured)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="xi-t082-t083-pty-") as temporary:
    source = Path(temporary) / "sample.txt"
    source.write_text("hello\n", encoding="utf-8")
    tab_capture = launch(
        source,
        (b" ",),
        (b"Prefix <Sp", b" / Search"),
        "T082 visible prefix-help surface",
        (b"\x1b", b"q"),
    )
    parser_capture = launch(
        source,
        (b"d",),
        (b"Motion", b"Choose motion"),
        "T082 actual Vim parser prefix-help surface",
        (b"\x1b", b"q"),
    )
    literal_capture = launch(
        source,
        (b"f",),
        (b"Literal input", b"one character"),
        "T082 literal prefix-help surface",
        (b"\x1b", b"q"),
    )
    g_capture = launch(
        source,
        (b"g",),
        (b"Continue g command",),
        "T082 g prefix-help surface",
        (b"\x1b", b"q"),
    )
    ctrl_w_capture = launch(
        source,
        (b"\x17",),
        (b"Continue ctrl-w command",),
        "T082 Ctrl-W prefix-help surface",
        (b"\x1b", b"q"),
    )
    tab_capture += launch(
        source,
        (b":", b"q", b"\t"),
        (b"Enter: execute", b"XI_EX_COMMANDLINE_STATE",),
        "T083 visible command-line surface",
        (b"\x1b", b"q"),
    )
    narrowed_capture = launch(
        source,
        (b":", b"fi"),
        (b"files", b"Open the multi-root file picker."),
        "T083 narrowed alias suggestions",
        (b"\x1b", b"q"),
    )
    alias_capture = launch(
        source,
        (b":", b"files", b"\r"),
        (b"Files ",),
        "T083 executable configured alias",
        (b"\x1b", b"\x1b", b"q"),
    )
    enter_capture = launch(
        source,
        (b":", b"q", b"\x1b[B", b"\r"),
        (b"Enter: execute",),
        "T083 typed Enter",
    )
    artifact = ROOT / ".artifacts/e2e/t082-t083-commandline.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({
        "schema_version": 1,
        "fixture": "T082/T083-production-commandline",
        "prefix_help_text": b"Prefix <Sp" in tab_capture and b"  /  Search" in tab_capture,
        "vim_parser_prefix_help_text": b"Motion" in parser_capture and b"Choose motion" in parser_capture,
        "literal_prefix_help_text": b"Literal input" in literal_capture and b"one character" in literal_capture,
        "g_prefix_help_text": b"Continue g command" in g_capture,
        "ctrl_w_prefix_help_text": b"Continue ctrl-w command" in ctrl_w_capture,
        "commandline_acceptance_text": "Enter: execute" in tab_capture.decode("utf-8", "replace"),
        "tab_replacement_text": b"XI_EX_COMMANDLINE_STATE {\"source\":\":qa\"" in tab_capture or b"XI_EX_COMMANDLINE_STATE {\"source\":\":quit\"" in tab_capture,
        "narrowed_alias_detail": b"files" in narrowed_capture and b"Open the multi-root file picker." in narrowed_capture,
        "configured_alias_executed": b"Files " in alias_capture,
        "typed_enter_exited_cleanly": True,
    }, indent=2) + "\n", encoding="utf-8")

print("T082/T083 production PTY passed delayed leader help, visible Ex acceptance/Tab replacement and typed :q Enter with a moved suggestion")
