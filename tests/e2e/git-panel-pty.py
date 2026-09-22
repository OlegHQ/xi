#!/usr/bin/env python3
"""Exercise the docked Git (Source Control) sidebar panel end to end: open via the Git tab,
render Staged/Changes/Untracked sections for a real repo, and stage a file with `s`."""
from __future__ import annotations

import os
import fcntl
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


def read_until(master: int, captured: bytearray, marker: bytes, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-5000:]!r}")


def mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    return f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode("ascii")


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)


with tempfile.TemporaryDirectory(prefix="xi-git-panel-") as temporary:
    repo = Path(temporary)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "xi@example.test")
    git(repo, "config", "user.name", "Xi Test")

    (repo / "alpha.ts").write_text("const alpha = 1;\n", encoding="utf-8")
    (repo / "beta.ts").write_text("const beta = 1;\n", encoding="utf-8")
    git(repo, "add", "alpha.ts", "beta.ts")
    git(repo, "commit", "-q", "-m", "initial")

    # One staged change (alpha.ts), one unstaged change to an already-tracked file (beta.ts),
    # one untracked new file (gamma.ts).
    (repo / "alpha.ts").write_text("const alpha = 2;\n", encoding="utf-8")
    git(repo, "add", "alpha.ts")
    (repo / "beta.ts").write_text("const beta = 2;\n", encoding="utf-8")
    (repo / "gamma.ts").write_text("const gamma = 1;\n", encoding="utf-8")
    config = repo / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[editor.workspace-trust]\nlevel = "insecure"\n', encoding="utf-8")

    main_file = repo / "beta.ts"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": "", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(main_file)],
        cwd=repo, env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        read_until(master, captured, b"XI_WORKBENCH_READY", 10)

        # Click the Git tab (row 1, x=23 per the ticket's coordinates for a 120-wide sidebar).
        os.write(master, mouse(0, 23, 1))
        os.write(master, mouse(0, 23, 1, True))
        read_until(master, captured, b"XI_GIT_PANEL_OPEN", 5)
        # The status refresh is an async subprocess; give it time to land and repaint.
        read_for(master, captured, 1.0)

        text = captured.decode("utf-8", errors="replace")
        for needed in ("Staged Changes", "Changes", "Untracked", "alpha.ts", "beta.ts", "gamma.ts"):
            if needed not in text:
                raise SystemExit(f"git panel missing {needed!r} in rendered output: {text[-4000:]!r}")

        # Click alpha.ts in the staged section. A Git-row click previews its diff in the
        # editor area while keeping the Git sidebar docked; it must not open the plain file
        # and expose the Files panel.
        os.write(master, mouse(0, 8, 5))
        os.write(master, mouse(0, 8, 5, True))
        read_until(master, captured, b'XI_GIT_DIFF_OPEN {"path":"alpha.ts","target":"index"}', 5)
        read_until(master, captured, b"XI_GIT_DIFF_READY", 5)
        if b"XI_GIT_PANEL_CLOSED" in captured:
            raise SystemExit("clicking a Git file closed the Git panel")
        # Opening focuses the first change in the comparison. q closes the read-only
        # index view and returns focus to Git without touching the working file.
        os.write(master, b"q")
        read_until(master, captured, b"XI_GIT_DIFF_CLOSED", 5)

        # Selection defaults to the first data row (staged.ts's alpha.ts); two `j` presses
        # move it to the second section's row (the unstaged beta.ts).
        os.write(master, b"jj")
        read_for(master, captured, 0.2)
        os.write(master, b"s")
        read_until(master, captured, b"XI_GIT_STAGE", 5)
        read_for(master, captured, 0.5)

        status = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True, check=True).stdout
        beta_line = next((line for line in status.splitlines() if line.endswith("beta.ts")), None)
        if beta_line is None or not beta_line.startswith("M"):
            raise SystemExit(f"beta.ts was not staged after XI_GIT_STAGE: {status!r}")

        # Escape closes the docked Git panel (returning keyboard focus to the editor); `:qa`
        # then quits the whole editor, exactly like tests/e2e/t043-search-pty.py's own exit.
        os.write(master, b"\x1b")
        read_for(master, captured, 0.2)
        os.write(master, b":qa\r")
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise SystemExit(f"git panel PTY did not quit: {captured[-7000:]!r}") from error
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"xi exited {child.returncode}: {captured[-7000:]!r}")

print("git-panel-pty passed: Git row click previews a diff without closing the docked panel, and 's' stages the selected file")
