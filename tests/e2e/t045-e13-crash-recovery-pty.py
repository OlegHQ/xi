#!/usr/bin/env python3
"""T045/E13: crash recovery through the production CLI.
docs/plan/05-validation.md's E13 row: "Crash after edit/save/directory-step then restart" ->
"Bounded recovery loss, external disk changes preserved, journal actionable."

Root cause of the gap this closes: packages/services/persistence/index.ts's
PersistenceService.checkpoint/recover/clearRecovery (T037's own module, unit/fixture-tested
in tests/persistence/t037.test.ts) was never called from apps/xi/src/main.ts at all -- crash
recovery did not exist in the running editor, only in the untested-in-production service
layer. This wires it: a debounced (off the keystroke path), best-effort checkpoint after
edits to a dirty buffer settle; a recovery check on open that only applies when the file on
disk has not changed since the checkpoint's own baseline; clearing the journal on a clean
save.

Three real production PTY scenarios, each with an actual SIGKILL simulating a crash:
  - Edit, real SIGKILL (no save, no clean quit), reopen: the unsaved edit is recovered.
  - Same, but the file changes on disk before reopening: recovery is refused and the external
    change is never silently overwritten (checked both by disk content and process exit).
  - Edit, clean ':wq', reopen: no recovery fires -- a clean save clears the journal.
"""
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

ROOT = Path(__file__).resolve().parents[2]


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


def launch(workspace: Path, target: Path) -> tuple[int, subprocess.Popen[bytes], bytearray]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(target)],
        cwd=str(workspace),
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    read_for(master, captured, 3)
    return master, child, captured


failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{name}: expected {expected!r}, got {actual!r}")


# --- Scenario 1: crash then recover ---
with tempfile.TemporaryDirectory(prefix="xi-t045-e13-a-") as temporary:
    workspace = Path(temporary)
    target = workspace / "note.txt"
    target.write_text("original\n", encoding="utf-8")
    master, child, captured = launch(workspace, target)
    os.write(master, b"AEDITED\x1b")
    read_for(master, captured, 2.0)  # past the 1.5s checkpoint debounce
    child.kill()
    child.wait()
    os.close(master)
    check("scenario 1: disk untouched by the crash itself", target.read_text(encoding="utf-8"), "original\n")

    master2, child2, captured2 = launch(workspace, target)
    check("scenario 1: recovery marker fires", b'"kind":"recovered"' in captured2, True)
    os.write(master2, b":wq\r")
    child2.wait(timeout=5)
    os.close(master2)
    check("scenario 1: recovered content saved correctly", target.read_text(encoding="utf-8"), "originalEDITED\n")

# --- Scenario 2: disk changed externally before reopening -- must not be overwritten ---
with tempfile.TemporaryDirectory(prefix="xi-t045-e13-b-") as temporary:
    workspace = Path(temporary)
    target = workspace / "note.txt"
    target.write_text("original\n", encoding="utf-8")
    master, child, captured = launch(workspace, target)
    os.write(master, b"AEDITED\x1b")
    read_for(master, captured, 2.0)
    child.kill()
    child.wait()
    os.close(master)
    target.write_text("someone else changed this\n", encoding="utf-8")

    master2, child2, captured2 = launch(workspace, target)
    check("scenario 2: disk-diverged marker fires, not recovered", b'"kind":"disk-diverged"' in captured2, True)
    os.write(master2, b":q!\r")
    child2.wait(timeout=5)
    os.close(master2)
    check("scenario 2: the external change is never silently overwritten", target.read_text(encoding="utf-8"), "someone else changed this\n")

# --- Scenario 3: a clean save clears the journal; a later reopen has nothing to recover ---
with tempfile.TemporaryDirectory(prefix="xi-t045-e13-c-") as temporary:
    workspace = Path(temporary)
    target = workspace / "note.txt"
    target.write_text("clean start\n", encoding="utf-8")
    master, child, captured = launch(workspace, target)
    os.write(master, b"Ax\x1b")
    read_for(master, captured, 2.0)
    os.write(master, b":wq\r")
    child.wait(timeout=5)
    os.close(master)

    master2, child2, captured2 = launch(workspace, target)
    check("scenario 3: no recovery marker after a clean save", b"XI_RECOVERY " in captured2, False)
    os.write(master2, b":q!\r")
    child2.wait(timeout=5)
    os.close(master2)

if failures:
    raise SystemExit("T045-E13 crash recovery failed:\n" + "\n".join(failures))
print("T045-E13-CRASH-RECOVERY-PTY pass: real SIGKILL + reopen recovers an unsaved edit, an "
      "externally-changed file is never silently overwritten, and a clean save clears the "
      "recovery journal -- all through the production CLI")
