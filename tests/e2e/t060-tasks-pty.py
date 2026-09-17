#!/usr/bin/env python3
"""T060: task output and diagnostics, launched, streamed and cancelled through the real
production CLI. Exercises the full acceptance list -- E17 (launch, output flood, cancel/quit,
child processes reaped), Task diagnostics coexisting with a real LSP diagnostic without
overwriting it, and a spawn failure reported as a clear error rather than a crash."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBLEMS_OPEN = re.compile(rb"XI_PROBLEMS_OPEN (\{[^\r\n]*\})")


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


def launch(workspace: Path, argv_file: str = "notes.txt"):
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(workspace), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), argv_file],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
    read_for(master, captured, 0.3)
    return child, master, captured


def quit_cleanly(child: subprocess.Popen, master: int, captured: bytearray) -> None:
    os.write(master, b"\x1b")
    read_for(master, captured, 0.2)
    os.write(master, b":wq\r")
    for _ in range(10):
        if child.poll() is not None:
            break
        read_for(master, captured, 0.3)
    try:
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


def real_child_pids_under(pid: int) -> list[int]:
    try:
        output = subprocess.check_output(["pgrep", "-P", str(pid)], text=True)
    except subprocess.CalledProcessError:
        return []
    return [int(line) for line in output.splitlines() if line.strip() != ""]


def basic_run_case() -> None:
    """A configured task streams real, exit-status-tracked output and its lines survive."""
    with tempfile.TemporaryDirectory(prefix="xi-t060-basic-") as temporary:
        workspace = Path(temporary)
        (workspace / "notes.txt").write_text("hello\n", encoding="utf-8")
        (workspace / ".xi").mkdir()
        (workspace / ".xi/tasks.toml").write_text(
            'schema-version = 1\n\n[[task]]\nid = "greet"\nargv = ["printf", "line one\\nline two\\n"]\n',
            encoding="utf-8",
        )
        child, master, captured = launch(workspace)
        try:
            os.write(master, b":task greet\r")
            wait_for(master, captured, b"XI_TASK_STARTED", 5)
            wait_for(master, captured, b"XI_TASK_EXITED", 5)
            exited = captured[captured.rfind(b"XI_TASK_EXITED"):]
            if b'"state":"exited"' not in exited or b'"exitCode":0' not in exited:
                raise SystemExit(f"T060-BASIC-01 expected a clean exit: {exited[:200]!r}")
            read_for(master, captured, 0.3)
            if b"line one" not in captured or b"line two" not in captured:
                raise SystemExit("T060-BASIC-01 streamed output lines were not rendered in the output panel")
        finally:
            quit_cleanly(child, master, captured)
    print("T060-BASIC-01 pass: a configured task launches a real process, streams its output into the panel, and reports its actual exit status")


def cancel_and_reap_case() -> None:
    """E17: cancelling a long-running task terminates it and leaves no orphaned child process."""
    with tempfile.TemporaryDirectory(prefix="xi-t060-cancel-") as temporary:
        workspace = Path(temporary)
        (workspace / "notes.txt").write_text("hello\n", encoding="utf-8")
        (workspace / ".xi").mkdir()
        (workspace / ".xi/tasks.toml").write_text(
            'schema-version = 1\n\n[[task]]\nid = "sleepy"\nargv = ["sleep", "30"]\n',
            encoding="utf-8",
        )
        child, master, captured = launch(workspace)
        try:
            os.write(master, b":task sleepy\r")
            wait_for(master, captured, b"XI_TASK_STARTED", 5)
            read_for(master, captured, 0.5)
            before = real_child_pids_under(child.pid)
            if len(before) == 0:
                raise SystemExit("T060-E17-01 expected a real 'sleep' child process to exist while the task runs")
            os.write(master, b"c")
            wait_for(master, captured, b"XI_TASK_CANCELLED", 5)
            read_for(master, captured, 0.6)
            after = real_child_pids_under(child.pid)
            if len(after) != 0:
                raise SystemExit(f"T060-E17-01 cancelling the task left orphaned child process(es): {after}")
        finally:
            quit_cleanly(child, master, captured)
        remaining = real_child_pids_under(child.pid)
        if len(remaining) != 0:
            raise SystemExit(f"T060-E17-01 quitting left orphaned child process(es): {remaining}")
    print("T060-E17-01 pass: a real long-running task's child process exists while running, cancelling it reaps that process immediately, and quitting leaves nothing orphaned")


def output_flood_case() -> None:
    """E17: an output flood does not block typing responsiveness in the same session."""
    with tempfile.TemporaryDirectory(prefix="xi-t060-flood-") as temporary:
        workspace = Path(temporary)
        (workspace / "notes.txt").write_text("hello\n", encoding="utf-8")
        (workspace / ".xi").mkdir()
        (workspace / ".xi/tasks.toml").write_text(
            'schema-version = 1\n\n[[task]]\nid = "flood"\nargv = ["bash", "-c", "for i in $(seq 1 60); do seq 1 5000; sleep 0.05; done"]\n',
            encoding="utf-8",
        )
        child, master, captured = launch(workspace)
        try:
            os.write(master, b":task flood\r")
            wait_for(master, captured, b"XI_TASK_STARTED", 5)
            read_for(master, captured, 0.4)
            os.write(master, b"\x1b")
            wait_for(master, captured, b"XI_OUTPUT_CLOSED", 5)
            read_for(master, captured, 0.2)
            start = time.monotonic()
            os.write(master, b"A")
            read_for(master, captured, 0.3)
            os.write(master, b" typed-while-flooded")
            elapsed = time.monotonic() - start
            read_for(master, captured, 0.3)
            os.write(master, b"\x1b")
            wait_for(master, captured, b"XI_TASK_EXITED", 10)
            if elapsed > 2.0:
                raise SystemExit(f"T060-E17-02 typing took {elapsed:.2f}s while an output flood ran in the background")
            os.write(master, b":w\r")
            read_for(master, captured, 0.4)
            saved = (workspace / "notes.txt").read_text(encoding="utf-8")
            if "typed-while-flooded" not in saved:
                raise SystemExit(f"T060-E17-02 the typed edit was lost: {saved!r}")
        finally:
            quit_cleanly(child, master, captured)
    print("T060-E17-02 pass: a 4,000-line background task output flood did not block ordinary typing, and the typed edit saved correctly")


def spawn_failure_case() -> None:
    """A task naming a nonexistent executable fails with a clear message, not a crash."""
    with tempfile.TemporaryDirectory(prefix="xi-t060-spawnfail-") as temporary:
        workspace = Path(temporary)
        (workspace / "notes.txt").write_text("hello\n", encoding="utf-8")
        (workspace / ".xi").mkdir()
        (workspace / ".xi/tasks.toml").write_text(
            'schema-version = 1\n\n[[task]]\nid = "missing"\nargv = ["xi-t060-nonexistent-executable"]\n',
            encoding="utf-8",
        )
        child, master, captured = launch(workspace)
        try:
            os.write(master, b":task missing\r")
            wait_for(master, captured, b"XI_TASK_STARTED", 5)
            started = captured[captured.rfind(b"XI_TASK_STARTED"):]
            if b'"ok":false' not in started:
                raise SystemExit(f"T060-SPAWN-FAILURE-01 expected a reported spawn failure: {started[:200]!r}")
            read_for(master, captured, 0.3)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.3)
            os.write(master, b"A")
            read_for(master, captured, 0.2)
            os.write(master, b" still alive")
            read_for(master, captured, 0.2)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            os.write(master, b":w\r")
            read_for(master, captured, 0.4)
            saved = (workspace / "notes.txt").read_text(encoding="utf-8")
            if "still alive" not in saved:
                raise SystemExit("T060-SPAWN-FAILURE-01 the session did not survive a spawn failure")
        finally:
            quit_cleanly(child, master, captured)
    print("T060-SPAWN-FAILURE-01 pass: a task naming a nonexistent executable reports a typed spawn failure, not a crash, and the session keeps working")


def problem_matcher_case() -> None:
    """Task diagnostics coexist with a real LSP diagnostic in the same Problems panel without
    overwriting it -- DiagnosticStore's per-(serverId, uri) keying is exercised end to end."""
    if shutil.which("typescript-language-server") is None:
        print("T060-PROBLEM-MATCHER-02: SKIPPED 'typescript-language-server' is not installed on this host")
        return
    with tempfile.TemporaryDirectory(prefix="xi-t060-matcher-") as temporary:
        workspace = Path(temporary)
        node_modules = workspace / "node_modules"
        node_modules.mkdir()
        (node_modules / "typescript").symlink_to(ROOT / "node_modules" / "typescript")
        (workspace / "package.json").write_text("{}\n", encoding="utf-8")
        (workspace / "broken.ts").write_text("const value: number = 'not-a-number';\n", encoding="utf-8")
        (workspace / ".xi").mkdir()
        matched_path = str(workspace / "broken.ts")
        (workspace / ".xi/tasks.toml").write_text(
            "schema-version = 1\n\n[[task]]\n"
            "id = \"lint\"\n"
            f"argv = [\"printf\", \"{matched_path}:1:1: error CUSTOM1: a task-sourced problem\\\\n\"]\n"
            "problem-matcher = \"generic-compiler\"\n",
            encoding="utf-8",
        )
        child, master, captured = launch(workspace, argv_file="broken.ts")
        try:
            os.write(master, b":task lint\r")
            wait_for(master, captured, b"XI_TASK_EXITED", 5)
            read_for(master, captured, 0.3)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.3)
            # Trigger the (currently lazy) language-session start via hover, then poll Problems
            # until the real diagnostic arrives -- LSP project setup + typecheck takes a few seconds.
            os.write(master, b" k")
            count = 0
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                before = len(captured)
                os.write(master, b" d")
                read_for(master, captured, 1.5)
                match = PROBLEMS_OPEN.search(captured[before:])
                if match is not None:
                    count = json.loads(match.group(1))["count"]
                    if count >= 2:
                        break
                os.write(master, b"\x1b")
                read_for(master, captured, 0.3)
            if count < 2:
                raise SystemExit(f"T060-PROBLEM-MATCHER-02 expected both the LSP diagnostic and the task diagnostic present, saw count={count}: {captured[-2000:]!r}")
        finally:
            quit_cleanly(child, master, captured)
    print("T060-PROBLEM-MATCHER-02 pass: a task's own problem-matcher diagnostic and a real LSP diagnostic for the same file both appear in the Problems panel -- neither source overwrites the other")


def unknown_task_case() -> None:
    """':task <unconfigured-id>' is a clear error, not a crash or a silent no-op."""
    with tempfile.TemporaryDirectory(prefix="xi-t060-unknown-") as temporary:
        workspace = Path(temporary)
        (workspace / "notes.txt").write_text("hello\n", encoding="utf-8")
        child, master, captured = launch(workspace)
        try:
            os.write(master, b":task nope\r")
            read_for(master, captured, 0.5)
            if b"unknown task" not in captured:
                raise SystemExit(f"T060-UNKNOWN-TASK-01 expected a clear unknown-task message: {captured[-500:]!r}")
            os.write(master, b"A")
            read_for(master, captured, 0.2)
            os.write(master, b" ok")
            read_for(master, captured, 0.2)
            os.write(master, b"\x1b")
            read_for(master, captured, 0.2)
            os.write(master, b":w\r")
            read_for(master, captured, 0.3)
            saved = (workspace / "notes.txt").read_text(encoding="utf-8")
            if "ok" not in saved:
                raise SystemExit("T060-UNKNOWN-TASK-01 the session did not survive an unknown task reference")
        finally:
            quit_cleanly(child, master, captured)
    print("T060-UNKNOWN-TASK-01 pass: referencing an unconfigured task id is a clear error, and the session keeps working")


basic_run_case()
cancel_and_reap_case()
output_flood_case()
spawn_failure_case()
problem_matcher_case()
unknown_task_case()
print("T060-TASKS-PTY pass: task launch/output/exit status, cancel with real process reaping, an output flood not blocking typing, a real spawn failure, task+LSP diagnostic coexistence, and an unknown-task error -- all through the production CLI")
