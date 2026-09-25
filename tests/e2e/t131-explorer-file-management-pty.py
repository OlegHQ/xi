#!/usr/bin/env python3
"""T131: Explorer rename/copy/delete with draft/cancel/apply/restore, through the production
CLI. docs/testing.md's E04 row: "Directory rename/copy/delete draft -> cancel ->
apply -> restore" -> "Exact filesystem diff, journal, no unintended deletion".

Before this ticket, apps/xi/src/main.ts's handleExplorerKeypress had no rename/copy/delete
action at all -- filesystem.renamePath/copyPath/removePath existed only as unused service
capabilities. This exercises the real, new Explorer keybindings: 'r' (rename draft, pre-filled
with the current name), 'y' (copy draft, pre-filled with the current name), 'd' (delete --
requires an explicit 'y' confirmation keystroke; anything else cancels with zero filesystem
effect), and 'u' (restore/undo the most recently applied operation from an in-memory,
session-scoped journal). Delete never permanently removes a file: it moves it into
<workspace>/.xi-trash/ (a same-filesystem rename, so it is atomic and genuinely reversible),
not a real destructive filesystem.removePath call.

Each scenario below uses its own fresh temporary workspace so a real mistake in one case can
never destroy another case's fixture files.
"""
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
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


def launch(workspace: Path, source: str) -> tuple[subprocess.Popen, int]:
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), source],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    return child, master


def quit_cleanly(child: subprocess.Popen, master: int, captured: bytearray) -> None:
    os.write(master, b":qa!\r")
    for _ in range(5):
        if child.poll() is not None:
            break
        read_for(master, captured, 0.3)
    child.wait(timeout=5)


def clear_field(master: int, captured: bytearray) -> None:
    for _ in range(20):
        os.write(master, b"\x7f")
    read_for(master, captured, 0.2)


def rename_case() -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t131-rename-") as temporary:
        workspace = Path(temporary)
        (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        (workspace / "target.txt").write_text("target content\n", encoding="utf-8")
        child, master = launch(workspace, "seed.txt")
        captured = bytearray()
        try:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"jj")  # root -> seed.txt -> target.txt
            read_for(master, captured, 0.4)

            # Draft, then cancel with Escape -- zero filesystem effect.
            os.write(master, b"r")
            read_for(master, captured, 0.2)
            clear_field(master, captured)
            os.write(master, b"cancelled.txt")
            read_for(master, captured, 0.2)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.3)
            if not (workspace / "target.txt").exists() or (workspace / "cancelled.txt").exists():
                raise SystemExit("cancelling a rename draft mutated the filesystem")

            # A rename target that already exists must be refused, not silently overwritten.
            os.write(master, b"r")
            read_for(master, captured, 0.2)
            clear_field(master, captured)
            os.write(master, b"seed.txt")
            read_for(master, captured, 0.2)
            before_conflict = len(captured)
            os.write(master, b"\r")
            read_for(master, captured, 0.4)
            if b"already exists" not in captured[before_conflict:] and b"open in a buffer" not in captured[before_conflict:]:
                raise SystemExit("renaming onto an existing file was not refused with a clear message")
            if (workspace / "target.txt").read_text(encoding="utf-8") != "target content\n" or (workspace / "seed.txt").read_text(encoding="utf-8") != "seed\n":
                raise SystemExit("a refused rename onto an existing target corrupted a file")

            # A real, valid rename: apply, then restore.
            os.write(master, b"r")
            read_for(master, captured, 0.2)
            clear_field(master, captured)
            os.write(master, b"renamed.txt")
            read_for(master, captured, 0.2)
            os.write(master, b"\r")
            wait_for(master, captured, b"XI_EXPLORER_RENAME_APPLIED", 5)
            read_for(master, captured, 0.3)
            if (workspace / "target.txt").exists() or not (workspace / "renamed.txt").exists():
                raise SystemExit("applying a valid rename did not produce the exact expected filesystem diff")
            if (workspace / "renamed.txt").read_text(encoding="utf-8") != "target content\n":
                raise SystemExit("rename did not preserve file content")

            os.write(master, b"u")
            wait_for(master, captured, b"XI_EXPLORER_RESTORE_APPLIED", 5)
            read_for(master, captured, 0.3)
            if not (workspace / "target.txt").exists() or (workspace / "renamed.txt").exists():
                raise SystemExit("restoring a rename did not reverse it exactly")
            if (workspace / "target.txt").read_text(encoding="utf-8") != "target content\n":
                raise SystemExit("restore did not preserve file content")

            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            quit_cleanly(child, master, captured)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
    return "rename: draft/cancel is a no-op, existing-target is refused, apply+restore round-trips exactly with content preserved"


def copy_case() -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t131-copy-") as temporary:
        workspace = Path(temporary)
        (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        (workspace / "source.txt").write_text("copy me\n", encoding="utf-8")
        child, master = launch(workspace, "seed.txt")
        captured = bytearray()
        try:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"jj")
            read_for(master, captured, 0.4)
            os.write(master, b"y")
            read_for(master, captured, 0.2)
            clear_field(master, captured)
            os.write(master, b"copy.txt")
            read_for(master, captured, 0.2)
            os.write(master, b"\r")
            wait_for(master, captured, b"XI_EXPLORER_COPY_APPLIED", 5)
            read_for(master, captured, 0.3)
            if not (workspace / "source.txt").exists() or not (workspace / "copy.txt").exists():
                raise SystemExit("applying a copy did not leave both the source and the new copy in place")
            if (workspace / "copy.txt").read_text(encoding="utf-8") != "copy me\n":
                raise SystemExit("copy did not preserve file content")

            os.write(master, b"u")
            wait_for(master, captured, b"XI_EXPLORER_RESTORE_APPLIED", 5)
            read_for(master, captured, 0.3)
            if not (workspace / "source.txt").exists() or (workspace / "copy.txt").exists():
                raise SystemExit("restoring a copy did not remove exactly the new copy, leaving the source untouched")

            before_paste = len(captured)
            os.write(master, b"Yp")
            deadline = time.monotonic() + 5
            while b"XI_EXPLORER_COPY_APPLIED" not in captured[before_paste:] and time.monotonic() < deadline:
                read_for(master, captured, 0.05)
            if b"XI_EXPLORER_COPY_APPLIED" not in captured[before_paste:] or (workspace / "source.txt copy").read_text(encoding="utf-8") != "copy me\n":
                raise SystemExit("Y then p did not paste a copy of the selected file")

            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            quit_cleanly(child, master, captured)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
    return "copy: draft and Y/paste preserve content; restore removes exactly the draft copy"


def delete_case() -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t131-delete-") as temporary:
        workspace = Path(temporary)
        (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        (workspace / "victim.txt").write_text("precious data\n", encoding="utf-8")
        child, master = launch(workspace, "seed.txt")
        captured = bytearray()
        try:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"jj")
            read_for(master, captured, 0.4)

            # No single keystroke may delete: 'd' alone only opens confirmation; anything but
            # 'y' cancels with zero filesystem effect.
            os.write(master, b"d")
            read_for(master, captured, 0.2)
            if not (workspace / "victim.txt").exists():
                raise SystemExit("pressing 'd' alone deleted a file before any confirmation")
            os.write(master, b"n")
            read_for(master, captured, 0.3)
            if not (workspace / "victim.txt").exists():
                raise SystemExit("a non-'y' response to the delete confirmation still deleted the file")

            # Confirmed delete: moves into .xi-trash (a real rename, not a permanent remove),
            # content intact, then restores exactly.
            os.write(master, b"d")
            read_for(master, captured, 0.2)
            os.write(master, b"y")
            wait_for(master, captured, b"XI_EXPLORER_DELETE_APPLIED", 5)
            read_for(master, captured, 0.3)
            if (workspace / "victim.txt").exists():
                raise SystemExit("a confirmed delete did not remove the file from its original path")
            trashed = list((workspace / ".xi-trash").rglob("*victim.txt"))
            if len(trashed) != 1 or trashed[0].read_text(encoding="utf-8") != "precious data\n":
                raise SystemExit("delete did not preserve the file's content in the trash for restore")

            os.write(master, b"u")
            wait_for(master, captured, b"XI_EXPLORER_RESTORE_APPLIED", 5)
            read_for(master, captured, 0.3)
            if not (workspace / "victim.txt").exists() or (workspace / "victim.txt").read_text(encoding="utf-8") != "precious data\n":
                raise SystemExit("restoring a delete did not bring the file back with its exact content")

            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            quit_cleanly(child, master, captured)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
    return "delete: requires explicit 'y' confirmation (no single keystroke deletes), moves to .xi-trash with content preserved, restores exactly"


def delete_dirty_buffer_case() -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t131-dirty-") as temporary:
        workspace = Path(temporary)
        (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        (workspace / "dirty.txt").write_text("clean\n", encoding="utf-8")
        child, master = launch(workspace, "seed.txt")
        captured = bytearray()
        try:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"ggj")
            read_for(master, captured, 0.3)
            os.write(master, b"\r")  # open dirty.txt
            read_for(master, captured, 0.5)
            os.write(master, b"A")
            read_for(master, captured, 0.2)
            os.write(master, b"UNSAVED")
            read_for(master, captured, 0.2)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"ggj")
            read_for(master, captured, 0.4)
            refusal = b""
            for _ in range(3):
                before = len(captured)
                os.write(master, b"d")
                read_for(master, captured, 0.2)
                os.write(master, b"y")
                read_for(master, captured, 0.6)
                refusal = captured[before:]
                if b"unsaved op" in refusal or b"unsaved open buffers" in refusal:
                    break
                if b"Files tree changed" not in refusal:
                    break
            if not (workspace / "dirty.txt").exists():
                raise SystemExit("a delete on a file with an unsaved open buffer was not refused")
            if b"unsaved op" not in refusal and b"unsaved open buffers" not in refusal:
                raise SystemExit("the unsaved-buffer delete refusal did not report a clear message")

            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            quit_cleanly(child, master, captured)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
    return "delete: a target with an unsaved open buffer is refused with a clear message, not silently discarded"


def restore_recreated_case() -> str:
    with tempfile.TemporaryDirectory(prefix="xi-t131-recreated-") as temporary:
        workspace = Path(temporary)
        (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        (workspace / "victim.txt").write_text("original\n", encoding="utf-8")
        child, master = launch(workspace, "seed.txt")
        captured = bytearray()
        try:
            wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
            os.write(master, b" vf")
            wait_for(master, captured, b"XI_EXPLORER_OPEN", 5)
            read_for(master, captured, 0.5)
            os.write(master, b"jj")
            read_for(master, captured, 0.4)
            os.write(master, b"d")
            read_for(master, captured, 0.2)
            os.write(master, b"y")
            wait_for(master, captured, b"XI_EXPLORER_DELETE_APPLIED", 5)
            read_for(master, captured, 0.3)

            (workspace / "victim.txt").write_text("externally recreated\n", encoding="utf-8")
            before = len(captured)
            os.write(master, b"u")
            read_for(master, captured, 0.4)
            if b"XI_EXPLORER_RESTORE_APPLIED" in captured[before:]:
                raise SystemExit("restore proceeded despite the original path being externally recreated")
            if (workspace / "victim.txt").read_text(encoding="utf-8") != "externally recreated\n":
                raise SystemExit("a refused restore overwrote the externally recreated file")
            if b"recreated" not in captured[before:]:
                raise SystemExit("the recreated-path restore refusal did not report a clear message")

            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            quit_cleanly(child, master, captured)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
    return "restore: refused when the original path was externally recreated, never overwrites it"


results = [rename_case(), copy_case(), delete_case(), delete_dirty_buffer_case(), restore_recreated_case()]
print("T131-EXPLORER-FILE-MANAGEMENT-PTY pass:")
for result in results:
    print(f"  - {result}")
