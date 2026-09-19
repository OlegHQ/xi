#!/usr/bin/env python3
"""Verify real PTY modes across exit, SIGTERM, job control and early failure."""
from __future__ import annotations

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MOUSE_ENTER = (b"\x1b[?1000h", b"\x1b[?1002h", b"\x1b[?1003h", b"\x1b[?1006h")
MOUSE_LEAVE = (b"\x1b[?1000l", b"\x1b[?1002l", b"\x1b[?1003l", b"\x1b[?1006l")
RAW_BITS = termios.ICANON | termios.ECHO


def read_for(master: int, output: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            return


def read_until(master: int, output: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in output and time.monotonic() < deadline:
        read_for(master, output, 0.05)
    if marker not in output:
        raise SystemExit(f"missing terminal PTY marker {marker!r}: {output[-3000:]!r}")


def raw_mode(fd: int) -> bool:
    return termios.tcgetattr(fd)[3] & RAW_BITS == 0


def stopped(pid: int) -> bool:
    try:
        status = (Path("/proc") / str(pid) / "status").read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    return any(line.startswith("State:") and line.split()[1] in {"T", "t"} for line in status.splitlines())


class RunningEditor:
    def __init__(self, temporary: str, source: Path):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        self.initial_lflag = termios.tcgetattr(self.slave)[3]
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
        self.child = subprocess.Popen(
            ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(source)],
            cwd=ROOT,
            env=environment,
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            close_fds=True,
        )
        os.close(self.slave)
        self.output = bytearray()
        read_until(self.master, self.output, b"XI_WORKBENCH_READY", 10)

    def finish(self) -> None:
        if self.child.poll() is None:
            self.child.kill()
            self.child.wait()
        os.close(self.master)

    def wait_exit(self, timeout: float = 5) -> int:
        deadline = time.monotonic() + timeout
        while self.child.poll() is None and time.monotonic() < deadline:
            read_for(self.master, self.output, 0.05)
        if self.child.poll() is None:
            raise SystemExit(f"renderer did not exit: {self.output[-3000:]!r}")
        read_for(self.master, self.output, 0.15)
        return int(self.child.returncode or 0)

    def modes_restored(self) -> bool:
        return all(mode in self.output for mode in MOUSE_LEAVE) and b"\x1b[?1049l" in self.output and b"\x1b[?25h" in self.output


with tempfile.TemporaryDirectory(prefix="xi-t094-terminal-pty-") as temporary:
    source = Path(temporary) / "terminal.txt"
    source.write_text("terminal lifecycle\n", encoding="utf-8")
    results: dict[str, object] = {}
    artifacts: dict[str, str] = {}

    clean = RunningEditor(temporary, source)
    try:
        clean_raw_while_running = raw_mode(clean.master)
        clean_enabled = all(mode in clean.output for mode in MOUSE_ENTER)
        os.write(clean.master, b"q")
        clean_exit = clean.wait_exit()
        results["cleanQuit"] = {
            "exitCode": clean_exit,
            "rawWhileRunning": clean_raw_while_running,
            "mouseEnabled": clean_enabled,
            "allMotionRestored": b"\x1b[?1003l" in clean.output,
            "modesRestored": clean.modes_restored(),
            "rawRestored": termios.tcgetattr(clean.master)[3] == clean.initial_lflag,
        }
        artifacts["cleanQuit"] = clean.output.decode("utf-8", errors="replace")
    finally:
        clean.finish()

    terminated = RunningEditor(temporary, source)
    try:
        term_before_signal = raw_mode(terminated.master)
        os.kill(terminated.child.pid, signal.SIGTERM)
        term_exit = terminated.wait_exit()
        results["sigterm"] = {
            "exitCode": term_exit,
            "rawBeforeSignal": term_before_signal,
            "modesRestored": terminated.modes_restored(),
            "rawRestored": termios.tcgetattr(terminated.master)[3] == terminated.initial_lflag,
        }
        artifacts["sigterm"] = terminated.output.decode("utf-8", errors="replace")
    finally:
        terminated.finish()

    job = RunningEditor(temporary, source)
    try:
        initial_enable_count = sum(job.output.count(mode) for mode in MOUSE_ENTER)
        os.kill(job.child.pid, signal.SIGTSTP)
        deadline = time.monotonic() + 5
        while not stopped(job.child.pid) and time.monotonic() < deadline:
            read_for(job.master, job.output, 0.05)
        stopped_cleanly = stopped(job.child.pid)
        raw_before_stop = not raw_mode(job.master)
        disabled_before_stop = all(mode in job.output for mode in MOUSE_LEAVE)
        enable_count_before_continue = sum(job.output.count(mode) for mode in MOUSE_ENTER)
        os.kill(job.child.pid, signal.SIGCONT)
        deadline = time.monotonic() + 5
        while (sum(job.output.count(mode) for mode in MOUSE_ENTER) <= enable_count_before_continue
               or not raw_mode(job.master)) and time.monotonic() < deadline:
            read_for(job.master, job.output, 0.05)
        resumed_cleanly = (sum(job.output.count(mode) for mode in MOUSE_ENTER) > enable_count_before_continue
                           and raw_mode(job.master))
        os.write(job.master, b"q")
        job_exit = job.wait_exit()
        results["suspendResume"] = {
            "stopped": stopped_cleanly,
            "rawRestoredBeforeStop": raw_before_stop,
            "mouseDisabledBeforeStop": disabled_before_stop,
            "mouseReenabledAndRawAfterContinue": resumed_cleanly,
            "initialMouseEnableCount": initial_enable_count,
            "exitCode": job_exit,
            "finalModesRestored": job.modes_restored(),
            "finalRawRestored": termios.tcgetattr(job.master)[3] == job.initial_lflag,
        }
        artifacts["suspendResume"] = job.output.decode("utf-8", errors="replace")
    finally:
        job.finish()

    missing = Path(temporary) / "missing.txt"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    initial_lflag = termios.tcgetattr(slave)[3]
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XI_UI_TEST_MARKERS": "1"})
    partial = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), str(missing)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    partial_output = bytearray()
    try:
        partial_exit = partial.wait(timeout=10)
        read_for(master, partial_output, 0.1)
        results["partialStartupFailure"] = {
            "exitCode": partial_exit,
            "rendererNeverEntered": not any(mode in partial_output for mode in MOUSE_ENTER) and b"\x1b[?1049h" not in partial_output,
            "rawUnchanged": termios.tcgetattr(master)[3] == initial_lflag,
            "diagnosed": b"cannot open" in partial_output,
        }
        artifacts["partialStartupFailure"] = partial_output.decode("utf-8", errors="replace")
    finally:
        if partial.poll() is None:
            partial.kill()
            partial.wait()
        os.close(master)

required = {
    "cleanQuit": results["cleanQuit"]["exitCode"] == 0 and results["cleanQuit"]["rawWhileRunning"] and results["cleanQuit"]["mouseEnabled"] and results["cleanQuit"]["allMotionRestored"] and results["cleanQuit"]["modesRestored"] and results["cleanQuit"]["rawRestored"],
    "sigterm": results["sigterm"]["exitCode"] == 0 and results["sigterm"]["rawBeforeSignal"] and results["sigterm"]["modesRestored"] and results["sigterm"]["rawRestored"],
    "suspendResume": results["suspendResume"]["stopped"] and results["suspendResume"]["rawRestoredBeforeStop"] and results["suspendResume"]["mouseDisabledBeforeStop"] and results["suspendResume"]["mouseReenabledAndRawAfterContinue"] and results["suspendResume"]["exitCode"] == 0 and results["suspendResume"]["finalModesRestored"] and results["suspendResume"]["finalRawRestored"],
    "partialStartupFailure": results["partialStartupFailure"]["rendererNeverEntered"] and results["partialStartupFailure"]["rawUnchanged"] and results["partialStartupFailure"]["diagnosed"],
}
artifact = ROOT / ".artifacts/e2e/t094-terminal.json"
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.write_text(json.dumps({"schema_version": 1, "fixture": "T094-MP02-terminal-lifecycle", "required": required, "results": results}, indent=2) + "\n", encoding="utf-8")
for name, output in artifacts.items():
    (artifact.parent / f"t094-terminal-{name}.ansi").write_text(output, encoding="utf-8")
if not all(required.values()):
    raise SystemExit(f"T094 terminal restoration PTY failed: {json.dumps({'required': required, 'results': results}, indent=2)}")
print("T094 terminal PTY passed clean quit, SIGTERM, suspend/resume, and pre-render startup failure")
