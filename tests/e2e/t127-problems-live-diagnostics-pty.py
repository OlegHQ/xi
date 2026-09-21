#!/usr/bin/env python3
"""Problems panel with real, live TypeScript diagnostics through the production CLI (T127).

Root cause of the earlier 'Problems panel has no rows' gap: Xi's declared LSP client
capabilities never included `textDocument.publishDiagnostics`, so a spec-compliant server
(confirmed against the real typescript-language-server 5.3.0 binary, by reading its own
source: `this.features.diagnosticsSupport = Boolean(publishDiagnostics)`) correctly concludes
the client does not want diagnostics pushed, and never sends any. Declaring the capability
(packages/services/language/lifecycle.ts) is a minimal, honest fix — no relatedInformation/
tagSupport/versionSupport is claimed, since DiagnosticPublish/LanguageDiagnostic do not model
those optional sub-fields.

This is a real production run: a real typescript-language-server process, a real type error,
real diagnostics arriving via a real textDocument/publishDiagnostics notification, and real
click activation of the resulting Problems row (the exact scenario T127's acceptance names as
'diagnostic rows' and that could not be exercised at all before this fix).
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
PANEL_POINTER = re.compile(rb"XI_PANEL_POINTER (\{[^\r\n]*\})")
PROBLEMS_OPEN = re.compile(rb"XI_PROBLEMS_OPEN (\{[^\r\n]*\})")


def require(*tools: str) -> str | None:
    for tool in tools:
        if shutil.which(tool) is None:
            return tool
    return None


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


def read_until(master: int, stderr: int, screen: Screen, diagnostics: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in diagnostics and time.monotonic() < deadline:
        read_for(master, stderr, screen, diagnostics, 0.05)
    if marker not in diagnostics:
        raise SystemExit(f"missing PTY marker {marker!r}: {diagnostics[-5000:]!r}")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def main() -> None:
    missing = require("typescript-language-server")
    if missing is not None:
        print(f"T127-PROBLEMS-LIVE-DIAGNOSTICS: SKIPPED {missing!r} is not installed on this host")
        return
    with tempfile.TemporaryDirectory(prefix="xi-t127-problems-live-") as temporary:
        workspace = Path(temporary)
        node_modules = workspace / "node_modules"
        node_modules.mkdir()
        (node_modules / "typescript").symlink_to(ROOT / "node_modules" / "typescript")
        (workspace / "package.json").write_text("{}\n", encoding="utf-8")
        source = workspace / "broken.ts"
        source.write_text("const value: number = 'not-a-number';\n", encoding="utf-8")
        config = workspace / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text("schema-version = 1\n[editor.statusline]\nright = [\"diagnostics\"]\ndiagnostics = [\"error\"]\n", encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1"})
        child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "broken.ts"],
            cwd=str(workspace),
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
        os.close(slave)
        diagnostics = bytearray()
        screen = Screen(40, 120)
        assert child.stderr is not None
        try:
            read_until(master, child.stderr.fileno(), screen, diagnostics, b"XI_WORKBENCH_READY", 10)
            # Trigger the (currently lazy) language-session start via hover, then poll Problems
            # until real diagnostics arrive — LSP project setup + typecheck takes a few seconds.
            os.write(master, b" k")
            count = 0
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                before = len(diagnostics)
                os.write(master, b" e")
                read_for(master, child.stderr.fileno(), screen, diagnostics, 1.5)
                match = PROBLEMS_OPEN.search(diagnostics[before:])
                if match is not None:
                    count = json.loads(match.group(1))["count"]
                    if count > 0:
                        break
                os.write(master, b"\x1b")
                read_for(master, child.stderr.fileno(), screen, diagnostics, 0.3)
            if count == 0:
                raise SystemExit(f"no real diagnostics arrived within 40s: {diagnostics[-4000:]!r}")
            if re.search(r"●\s*1", screen.row_text(40)) is None:
                raise SystemExit(f"configured statusline did not render the filtered diagnostic count: {screen.row_text(40)!r}")

            # Real click activation of the diagnostic row (T127's own acceptance scenario).
            # Problems panel bounds at 120x40: left=1, top=27, height=12 -> header at PTY row
            # 28 (1-based), the first diagnostic row at PTY row 29.
            before = len(diagnostics)
            os.write(master, mouse(0, 5, 29))
            os.write(master, mouse(0, 5, 29, True))
            read_for(master, child.stderr.fileno(), screen, diagnostics, 1.0)
            events = [json.loads(m.group(1)) for m in PANEL_POINTER.finditer(diagnostics[before:])]
            hit = next((event for event in events if event.get("panel") == "problems" and event.get("action") == "activate"), None)
            if hit is None:
                raise SystemExit(f"no production Problems row activated by stable id: {diagnostics[before:][-4000:]!r}")

            os.write(master, b":q!\r")
            child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)

    print(f"T127-PROBLEMS-LIVE-DIAGNOSTICS pass: {count} real diagnostic(s) arrived and its row activated by stable item id")


if __name__ == "__main__":
    main()
