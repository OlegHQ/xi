#!/usr/bin/env python3
"""Exercise mini.files-style drafts, registers, focus and filesystem safety in real PTYs."""
from __future__ import annotations

import os
import fcntl
import struct
import termios
import re
from terminal_screen import Screen
import argparse
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path)
arguments = parser.parse_args()
COMMAND = [str(arguments.binary.resolve())] if arguments.binary else ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts')]


def drain(master: int, output: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                return


class Editor:
    def __init__(self, workspace: Path, source: str = "seed.txt"):
        self.workspace = workspace
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        env = os.environ.copy()
        env.update(HOME=str(workspace), TERM="xterm-256color", XI_UI_TEST_MARKERS="1")
        self.child = subprocess.Popen([*COMMAND, source],
                                     cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        self.output = bytearray()
        self.wait(b"XI_WORKBENCH_READY")

    def keys(self, keys: bytes) -> None:
        os.write(self.master, keys)
        drain(self.master, self.output, 0.3)

    def wait(self, marker: bytes, start: int = 0) -> None:
        deadline = time.monotonic() + 8
        while marker not in self.output[start:] and time.monotonic() < deadline:
            drain(self.master, self.output, 0.05)
        assert marker in self.output[start:], f"missing {marker!r}: {self.output[-4000:]!r}"

    def files(self) -> None:
        start = len(self.output)
        self.keys(b" vf")
        self.wait(b"XI_FILES_CURSOR")
        assert any('NORMAL' in line for line in sidebar(self)), 'Files mode footer was not rendered'

    def sync(self) -> None:
        start = len(self.output)
        self.keys(b"=")
        self.wait(b"XI_FILES_REVIEW", start)
        self.keys(b"y")
        self.wait(b"XI_FILES_APPLIED", start)

    def close(self) -> None:
        try:
            self.keys(b"\x1b")
            self.keys(b"\x1b")
            self.keys(b":qa!\r")
            deadline = time.monotonic() + 5
            while self.child.poll() is None and time.monotonic() < deadline:
                drain(self.master, self.output, 0.05)
            assert self.child.returncode == 0, f"Xi did not exit cleanly: {self.output[-4000:]!r}"
        finally:
            if self.child.poll() is None:
                self.child.kill()
                self.child.wait()
            os.close(self.master)


def sidebar(editor: Editor) -> list[str]:
    screen = Screen(40, 120)
    screen.feed(re.sub(rb'XI_[A-Z_]+(?: [^\r\n]*)?\r+\n', b'', editor.output))
    return [screen.row_text(row)[:29] for row in range(1, 39)]


def click(editor: Editor, name: str) -> None:
    lines = sidebar(editor)
    row = next((index + 1 for index, line in enumerate(lines) if name in line), None)
    assert row is not None, (name, lines)
    editor.keys(f"\x1b[<0;10;{row}M\x1b[<0;10;{row}m".encode())


def mouse_and_tree_editing() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-files-tree-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        (workspace / "apps").mkdir()
        (workspace / "bench/document").mkdir(parents=True)
        (workspace / "bench/core").mkdir()
        (workspace / "bench/manifest.json").write_text('{}')
        (workspace / "bench/document/alpha.ts").write_text('alpha')
        (workspace / "bench/document/beta.ts").write_text('beta')
        editor = Editor(workspace)
        try:
            drain(editor.master, editor.output, .5)
            click(editor, "bench")
            click(editor, "document")
            lines = sidebar(editor)
            assert all(any(name in line for line in lines) for name in ('apps', 'bench', 'core', 'document', 'alpha.ts', 'beta.ts', 'seed.txt')), lines
            folder_column = next(line.index('document') for line in lines if 'document' in line)
            child_column = next(line.index('alpha.ts') for line in lines if 'alpha.ts' in line)
            assert child_column > folder_column, "Vim activation flattened the original tree"
            click(editor, "alpha.ts")
            editor.keys(b"dd")
            assert not any('alpha.ts' in line for line in sidebar(editor)), "dd did not remove its inline draft row"
            assert (workspace / 'bench/document/alpha.ts').read_text() == 'alpha'
            editor.keys(b"u")
            assert any('alpha.ts' in line for line in sidebar(editor)), "Files undo did not restore its tree row"
            editor.keys(b"onew.ts\x1b")
            lines = sidebar(editor)
            assert any('new.ts' in line and line.index('new.ts') == child_column for line in lines), lines
            assert any('seed.txt' in line for line in lines), "inline insertion replaced the workspace tree"
            editor.keys(b"u")
            click(editor, "document")
            assert not any('alpha.ts' in line for line in sidebar(editor))
            editor.keys(b">")
            assert any('alpha.ts' in line for line in sidebar(editor)), "> did not expand selected folder"
            editor.keys(b"<")
            assert not any('alpha.ts' in line for line in sidebar(editor)), "< did not collapse selected folder"
        finally:
            editor.close()


def setup(workspace: Path) -> None:
    (workspace / "seed.txt").write_bytes(b"seed\n")
    (workspace / "target.txt").write_bytes(b"target content\n")


def isolated_undo_and_rename() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-files-undo-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        editor = Editor(workspace)
        try:
            editor.keys(b"iEDITOR\x1b")
            editor.files()
            editor.keys(b"/target\rdd")
            assert (workspace / "target.txt").read_bytes() == b"target content\n", "draft delete touched disk"
            editor.keys(b"u\x17w:w\r")
            assert (workspace / "seed.txt").read_bytes() == b"EDITORseed\n", "Files u undid the editor buffer"
            editor.keys(b"u:w\r")
            assert (workspace / "seed.txt").read_bytes() == b"seed\n", "editor u did not undo its own edit"
            editor.files()
            editor.keys(b"/target\rCcancelled.txt\x1bu")
            assert (workspace / "target.txt").read_bytes() == b"target content\n", "undo of rename draft touched disk"
            editor.keys(b"Cseed.txt\x1b=")
            assert b"duplicate destination" in editor.output, "invalid rename did not show its validation error"
            assert (workspace / "seed.txt").read_bytes() == b"seed\n", "collision overwrote another file"
            editor.keys(b"uCrenamed.txt\x1b=\x1b")
            assert not (workspace / "renamed.txt").exists(), "cancelled review applied a rename"
            editor.sync()
            assert (workspace / "renamed.txt").read_bytes() == b"target content\n"
            assert not (workspace / "target.txt").exists()
        finally:
            editor.close()


def registers_and_create() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-files-registers-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        (workspace / "destination").mkdir()
        editor = Editor(workspace)
        try:
            editor.files()
            editor.keys(b"/target\rddgglp")
            editor.sync()
            assert (workspace / "destination/target.txt").read_bytes() == b"target content\n", "dd/p did not move exact content"
            assert not (workspace / "target.txt").exists()
            editor.keys(b"onew.txt\x1b")
            editor.keys(b"Ofolder/\x1b")
            assert not (workspace / "destination/new.txt").exists(), "o created a file before synchronization"
            editor.sync()
            assert (workspace / "destination/new.txt").read_bytes() == b""
            assert (workspace / "destination/folder").is_dir(), "O plus trailing slash did not create a directory"
            editor.keys(b"o\x1b[200~pasted.txt\x1b[201~\x1b")
            editor.sync()
            assert (workspace / "destination/pasted.txt").read_bytes() == b"", "bracketed paste bypassed the Files insert buffer"
            editor.keys(b"h/seed\r\"ayyggl\"ap")
            editor.sync()
            assert (workspace / "destination/seed.txt").read_bytes() == b"seed\n", "named yy/p did not copy exact content"
            assert (workspace / "seed.txt").read_bytes() == b"seed\n", "copy removed original"
        finally:
            editor.close()


def trash_and_dirty_refusal() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-files-trash-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        editor = Editor(workspace)
        try:
            editor.files()
            editor.keys(b"/target\rdd")
            editor.sync()
            assert not (workspace / "target.txt").exists()
            assert any(path.read_bytes() == b"target content\n" for path in (workspace / ".xi-trash").rglob("*target.txt")), "delete lost file content instead of moving it to trash"
        finally:
            editor.close()
    with tempfile.TemporaryDirectory(prefix="xi-files-dirty-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        editor = Editor(workspace, "target.txt")
        try:
            editor.keys(b"A unsaved\x1b")
            editor.files()
            start = len(editor.output)
            editor.keys(b"dd=y")
            assert b"unsaved open buffers" in editor.output[start:], "dirty-buffer deletion did not explain refusal"
            assert b"XI_FILES_APPLIED" not in editor.output[start:]
            assert (workspace / "target.txt").read_bytes() == b"target content\n", "dirty-buffer refusal changed disk"
            editor.keys(b"\x1bu")  # cancel review and restore the Files draft
        finally:
            editor.close()


def external_destination() -> None:
    with tempfile.TemporaryDirectory(prefix="xi-files-external-") as temporary:
        workspace = Path(temporary)
        setup(workspace)
        editor = Editor(workspace)
        try:
            editor.files()
            editor.keys(b"/target\rCmoved.txt\x1b=")
            (workspace / "moved.txt").write_bytes(b"external\n")
            start = len(editor.output)
            editor.keys(b"y")
            assert b"XI_FILES_APPLIED" not in editor.output[start:], "externally occupied rename was applied"
            assert (workspace / "moved.txt").read_bytes() == b"external\n"
            assert (workspace / "target.txt").read_bytes() == b"target content\n"
            editor.keys(b"\x1bu")
        finally:
            editor.close()


mouse_and_tree_editing()
isolated_undo_and_rename()
registers_and_create()
trash_and_dirty_refusal()
external_destination()
print("Files management PTY passed: isolated undo, rename/cancel/collision, dd/p move, named yy/p copy, o/O creates, trash, dirty-buffer refusal and external destination preservation")
