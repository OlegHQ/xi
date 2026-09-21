#!/usr/bin/env python3
"""Exercise automatic signature-help requests through the production input router."""
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


def run_case(root: Path, enabled: bool) -> None:
    root.mkdir()
    (root / "package.json").write_text("{}\n", encoding="utf-8")
    (root / "main.ts").write_text("Math.max\n", encoding="utf-8")
    config = root / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(f"[editor.lsp]\nauto-signature-help = {'true' if enabled else 'false'}\n", encoding="utf-8")

    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(root), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.ts"],
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
            read_for(master, captured, 0.05)
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start ({enabled=})\n{captured[-3000:]!r}")

        # A at the end enters Insert mode and `(` changes the document inside a call.
        os.write(master, b"A(")
        read_for(master, captured, 8 if enabled else 1)
        opened = b"XI_SIGNATURE_OPEN" in captured
        if opened != enabled:
            raise SystemExit(f"auto signature-help gate mismatch ({enabled=} {opened=})\n{captured[-5000:]!r}")

        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b"\x1b")
        time.sleep(0.15)
        os.write(master, b":q!\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            read_for(master, captured, 0.05)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode} ({enabled=})\n{captured[-8000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t036-auto-signature-help-") as temporary:
    run_case(Path(temporary) / "enabled", True)
    run_case(Path(temporary) / "disabled", False)

print("T036 production PTY passed automatic signature-help enable/disable cases")
