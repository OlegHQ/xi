#!/usr/bin/env python3
"""Drive OpenTUI pointer parsing through a genuine Linux kernel PTY."""

from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import termios
import time


ROOT = Path.cwd()
ARTIFACTS = ROOT / ".artifacts" / "input" / "T084"
READY = b"XI_READY "
EVENT = b"XI_EVENT "
CHUNK = b"XI_CHUNK "
PHASE = b"XI_PHASE "
HANDLER_ERROR = b"XI_HANDLER_ERROR "
RENDERER_MOUSE = b"XI_RENDERER_MOUSE "
MODES = re.compile(rb"\x1b\[\?([0-9;]+)([hl])")


def set_winsize(fd: int, columns: int = 300, rows: int = 40) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


class PtyProbe:
    def __init__(self, mode: str, timeout_seconds: float = 12.0):
        self.mode = mode
        self.timeout_seconds = timeout_seconds
        self.captured = bytearray()
        self.events: list[dict[str, object]] = []
        self.chunks: list[dict[str, object]] = []
        self.phases: list[dict[str, object]] = []
        self.handler_errors: list[dict[str, object]] = []
        self.renderer_mouse_callbacks: list[dict[str, object]] = []
        self.scan_positions: dict[bytes, int] = {}
        self.master_fd = -1
        self.child_pid = -1
        self.child_status: int | None = None
        self.pty_open = False
        self.deadline = 0.0
        self.raw_path = ARTIFACTS / f"{mode}.ansi"
        self.status_path = ARTIFACTS / f"{mode}.status.json"

    def start(self) -> dict[str, object]:
        self.status_path.unlink(missing_ok=True)
        self.raw_path.unlink(missing_ok=True)
        self.child_pid, self.master_fd = pty.fork()
        if self.child_pid == 0:
            child_env = os.environ.copy()
            child_env["TERM"] = "xterm-256color"
            child_env["COLORTERM"] = "truecolor"
            os.execvpe("bun", ["bun", "run", "prototypes/pointer/terminal-probe.ts", self.mode], child_env)
        self.pty_open = True
        set_winsize(self.master_fd)
        self.deadline = time.monotonic() + self.timeout_seconds
        ready = self.wait_for(READY)
        if ready.get("mode") != self.mode or ready.get("width") != 300 or ready.get("rawMode") is not True:
            raise AssertionError(f"renderer not ready at 300 columns: {ready}")
        if ready.get("useMouse") is not (self.mode != "disabled"):
            raise AssertionError(f"unexpected mouse support state: {ready}")
        return ready

    def parse_markers(self) -> None:
        for marker, target in (
            (EVENT, self.events),
            (CHUNK, self.chunks),
            (PHASE, self.phases),
            (HANDLER_ERROR, self.handler_errors),
            (RENDERER_MOUSE, self.renderer_mouse_callbacks),
        ):
            scan_position = self.scan_positions.get(marker, 0)
            while True:
                position = self.captured.find(marker, scan_position)
                if position < 0:
                    break
                end = self.captured.find(b"\r\n", position)
                if end < 0:
                    break
                item = json.loads(self.captured[position + len(marker):end].decode("utf-8"))
                target.append(item)
                scan_position = end + 2
            self.scan_positions[marker] = scan_position

    def read_once(self, timeout: float) -> None:
        if not self.pty_open:
            return
        readable, _, _ = select.select([self.master_fd], [], [], timeout)
        if not readable:
            return
        try:
            chunk = os.read(self.master_fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                self.pty_open = False
                return
            raise
        if chunk:
            self.captured.extend(chunk)
        else:
            self.pty_open = False

    def check_alive(self) -> None:
        if self.child_status is not None:
            raise AssertionError(f"renderer exited unexpectedly: wait status {self.child_status}")
        waited, status = os.waitpid(self.child_pid, os.WNOHANG)
        if waited == self.child_pid:
            self.child_status = status

    def wait_for(self, marker: bytes, predicate=lambda: True) -> dict[str, object] | None:
        local_deadline = min(self.deadline, time.monotonic() + self.timeout_seconds)
        while time.monotonic() < local_deadline:
            self.parse_markers()
            if marker == READY:
                start = 0
                while True:
                    position = self.captured.find(marker, start)
                    if position < 0:
                        break
                    end = self.captured.find(b"\r\n", position)
                    if end < 0:
                        break
                    return json.loads(self.captured[position + len(marker):end].decode("utf-8"))
            elif predicate():
                return None
            self.read_once(0.002)
            self.check_alive()
        raise TimeoutError(f"timed out waiting for {marker!r} in {self.raw_path}")

    def settle(self, seconds: float = 0.06) -> None:
        end = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < end:
            self.read_once(min(0.002, end - time.monotonic()))
            self.parse_markers()
            self.check_alive()

    def send(self, data: bytes) -> None:
        os.write(self.master_fd, data)

    def wait_for_events(self, count: int) -> None:
        end = min(self.deadline, time.monotonic() + 1.0)
        while len(self.events) < count and time.monotonic() < end:
            self.read_once(0.002)
            self.parse_markers()
            self.check_alive()
        if len(self.events) < count:
            raise TimeoutError(f"expected {count} events, received {len(self.events)}")

    def send_split(self, packet: bytes, split_at: int) -> list[str]:
        before = len(self.chunks)
        before_events = len(self.events)
        self.send(packet[:split_at])
        self.wait_for(CHUNK, lambda: len(self.chunks) > before)
        first_chunks = len(self.chunks)
        self.send(packet[split_at:])
        self.wait_for_events(before_events + 1)
        self.settle(0.03)
        consumed = self.chunks[before:]
        observed = b"".join(bytes.fromhex(str(item["hex"])) for item in consumed)
        if observed != packet:
            raise AssertionError(f"split SGR bytes changed: expected {packet.hex()}, got {observed.hex()}")
        if first_chunks <= before or len(consumed) < 2 or any(packet.hex() == item.get("hex") for item in consumed):
            raise AssertionError(f"split boundary was not observed in distinct PTY reads: {consumed}")
        return [str(item["hex"]) for item in consumed]

    def finish(self, quit_with_key: bool = True) -> dict[str, object]:
        if quit_with_key:
            before_events = len(self.events)
            self.send(b"q")
            self.wait_for_events(before_events + 1)
        end = time.monotonic() + 2.0
        while self.child_status is None and time.monotonic() < end:
            self.read_once(0.01)
            self.parse_markers()
            waited, status = os.waitpid(self.child_pid, os.WNOHANG)
            if waited == self.child_pid:
                self.child_status = status
        if self.child_status is None:
            raise TimeoutError(f"renderer did not finish: {self.raw_path}")
        while self.pty_open:
            self.read_once(0.02)
            self.parse_markers()
        self.raw_path.write_bytes(self.captured)
        if not os.WIFEXITED(self.child_status) or os.WEXITSTATUS(self.child_status) != 0:
            raise AssertionError(f"renderer exit failed: status={self.child_status}, output={self.raw_path}")
        if not self.status_path.exists():
            raise AssertionError(f"renderer omitted lifecycle report: {self.status_path}")
        status = json.loads(self.status_path.read_text("utf-8"))
        if status.get("rendererDestroyed") is not True or status.get("targetDestroyed") is not True:
            raise AssertionError(f"renderer or target was not destroyed: {status}")
        raw_mode = status.get("rawMode")
        if not isinstance(raw_mode, dict) or raw_mode.get("restored") is not True:
            raise AssertionError(f"terminal raw mode not restored: {status}")
        return status

    def close(self) -> None:
        if self.child_pid > 0 and self.child_status is None:
            try:
                os.kill(self.child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                _, self.child_status = os.waitpid(self.child_pid, 0)
            except ChildProcessError:
                pass
        if self.master_fd >= 0:
            os.close(self.master_fd)
            self.master_fd = -1


def sgr(code: int, column1: int, row1: int, release: bool = False) -> bytes:
    ending = "m" if release else "M"
    return f"\x1b[<{code};{column1};{row1}{ending}".encode("ascii")


def mode_transitions(captured: bytes) -> list[str]:
    transitions: list[str] = []
    for match in MODES.finditer(captured):
        value = match.group(1).decode("ascii")
        action = match.group(2).decode("ascii")
        if any(number in ("1000", "1002", "1003", "1006") for number in value.split(";")):
            transitions.append(f"{value}{action}")
    return transitions


def run_enabled() -> dict[str, object]:
    probe = PtyProbe("enabled")
    split_cases: list[dict[str, object]] = []
    try:
        ready = probe.start()
        probe.send(b"x")
        probe.wait_for_events(1)

        # SGR is one-based on the wire and must support coordinates > 255.
        probe.send(sgr(0, 257, 3))
        probe.wait_for_events(2)
        probe.send(sgr(32, 259, 4))
        probe.wait_for_events(3)
        probe.send(sgr(0, 260, 4, release=True))
        probe.wait_for_events(4)
        probe.send(sgr(64, 299, 10))
        probe.wait_for_events(5)
        probe.send(sgr(65, 300, 10))
        probe.wait_for_events(6)

        for modifier, code in (("shift", 4), ("alt", 8), ("ctrl", 16)):
            before = len(probe.events)
            probe.send(sgr(code, 270, 12))
            probe.wait_for_events(before + 1)
            before = len(probe.events)
            probe.send(sgr(code, 270, 12, release=True))
            probe.wait_for_events(before + 1)

        # A cell immediately past the 300-column frame is discarded by hit-test.
        before = len(probe.events)
        probe.send(sgr(0, 301, 12))
        probe.settle()
        if len(probe.events) != before:
            raise AssertionError(f"out-of-frame report reached a renderable: {probe.events[before:]}")

        # Exercise distinct OS read boundaries at introducer, separators and terminator.
        for index, split_at in enumerate((1, 2, 3, 4, 6, 8, 10)):
            packet = sgr(2, 150 + index, 20 + index)
            before_events = len(probe.events)
            chunks = probe.send_split(packet, split_at)
            if len(probe.events) != before_events + 1:
                raise AssertionError(f"split packet delivered {len(probe.events) - before_events} events")
            split_cases.append({"splitAtByte": split_at, "packetHex": packet.hex(), "readChunksHex": chunks})
            before = len(probe.events)
            probe.send(sgr(2, 150 + index, 20 + index, release=True))
            probe.wait_for_events(before + 1)

        # Simulate a release lost during suspend; parser state must reset.
        lost_release_start = len(probe.events)
        before = len(probe.events)
        probe.send(sgr(0, 257, 3))
        probe.wait_for_events(before + 1)

        # OpenTUI's public suspend/resume API must release and restore both modes.
        before = len(probe.events)
        probe.send(b"s")
        probe.wait_for_events(before + 1)
        probe.wait_for(PHASE, lambda: any(item.get("phase") == "resumed" for item in probe.phases))
        before = len(probe.events)
        probe.send(sgr(32, 259, 4))
        probe.wait_for_events(before + 1)
        before = len(probe.events)
        probe.send(sgr(0, 257, 3, release=True))
        probe.wait_for_events(before + 1)

        # Bracketed paste carries key-looking bytes as one text payload beside mouse traffic.
        before = len(probe.events)
        probe.send(b"\x1b[200~x\x1b[A\nq\x1b[201~")
        probe.wait_for_events(before + 1)
        status = probe.finish()
        modes = mode_transitions(bytes(probe.captured))
        enabled_codes = [code for code in modes if code.endswith("h")]
        disabled_codes = [code for code in modes if code.endswith("l")]
        if not any("1002" in code for code in enabled_codes) or not any("1006" in code for code in enabled_codes):
            raise AssertionError(f"renderer did not enable SGR/button-motion modes: {modes}")
        if any("1003" in code for code in enabled_codes):
            raise AssertionError(f"Xi button/drag configuration unnecessarily enabled all-motion 1003: {modes}")
        if not any("1002" in code for code in disabled_codes) or not any("1006" in code for code in disabled_codes):
            raise AssertionError(f"renderer did not restore SGR/button-motion modes on quit: {modes}")
        lifecycle = status.get("lifecycle")
        if not isinstance(lifecycle, list) or not any(row.get("phase") == "suspended" and row.get("rawMode") is False and row.get("useMouse") is False for row in lifecycle):
            raise AssertionError(f"suspend did not release raw/mouse modes: {lifecycle}")
        if not any(row.get("phase") == "resumed" and row.get("rawMode") is True and row.get("useMouse") is True for row in lifecycle):
            raise AssertionError(f"resume did not restore raw/mouse modes: {lifecycle}")
        lost_release_events = [event for event in status["events"][lost_release_start:] if event.get("kind") == "mouse"]
        if [event.get("eventType") for event in lost_release_events] != ["down", "move", "up"]:
            raise AssertionError(f"a lost pre-suspend release left a stuck drag state: {lost_release_events}")
        normalized_mouse = [event for event in status["events"] if event.get("kind") == "mouse"]
        if len(normalized_mouse) != 28:
            raise AssertionError(f"expected one normalized event for each of 28 on-frame SGR reports, got {len(normalized_mouse)}")
        if [event.get("eventType") for event in normalized_mouse[:3]] != ["down", "drag", "up"]:
            raise AssertionError(f"press/drag/release normalization differs: {normalized_mouse[:5]}")
        raw_lifecycle = [row.get("type") for row in status.get("rawMouseCallbacks", [])]
        if raw_lifecycle[:6] != ["down", "drag", "drag-end", "up", "drop", "up"]:
            raise AssertionError(f"pinned renderer release callback sequence changed: {raw_lifecycle[:8]}")
        keys = [event.get("name") for event in status["events"] if event.get("kind") == "key"]
        if keys != ["x", "s", "q"]:
            raise AssertionError(f"a pointer packet leaked as text or a key event: {keys}")
        pastes = [event for event in status["events"] if event.get("kind") == "paste"]
        if len(pastes) != 1 or pastes[0].get("payloadHex") != "781b5b410a71":
            raise AssertionError(f"mouse traffic changed adjacent bracketed paste: {pastes}")
        return {
            "mode": "enabled",
            "ready": ready,
            "eventCount": len(status.get("events", [])),
            "status": status,
            "rawRendererMouseCallbackCount": len(status.get("rawMouseCallbacks", [])),
            "lostReleaseEvents": lost_release_events,
            "splitCases": split_cases,
            "mouseModeTransitions": modes,
            "artifacts": {"terminalCapture": str(probe.raw_path), "lifecycle": str(probe.status_path)},
        }
    finally:
        probe.close()


def run_disabled() -> dict[str, object]:
    probe = PtyProbe("disabled")
    try:
        ready = probe.start()
        probe.send(sgr(0, 20, 5))
        probe.settle()
        if probe.events:
            raise AssertionError(f"disabled mouse mode delivered an event or converted it to text: {probe.events}")
        status = probe.finish()
        modes = mode_transitions(bytes(probe.captured))
        if any(code.endswith("h") and any(n in code for n in ("1000", "1002", "1003", "1006")) for code in modes):
            raise AssertionError(f"disabled mouse mode unexpectedly enabled tracking: {modes}")
        return {"mode": "disabled", "ready": ready, "status": status, "mouseModeTransitions": modes}
    finally:
        probe.close()


def run_all_motion() -> dict[str, object]:
    probe = PtyProbe("all-motion")
    try:
        ready = probe.start()
        status = probe.finish()
        modes = mode_transitions(bytes(probe.captured))
        enabled_codes = [code for code in modes if code.endswith("h")]
        if not any("1003" in code for code in enabled_codes):
            raise AssertionError(f"enableMouseMovement=true did not demonstrate all-motion mode: {modes}")
        return {
            "mode": "all-motion",
            "ready": ready,
            "status": status,
            "mouseModeTransitions": modes,
            "observation": "enableMouseMovement=true adds 1003; Xi can opt out while retaining 1002 and SGR 1006.",
            "enabledCodes": enabled_codes,
        }
    finally:
        probe.close()


def run_failure() -> dict[str, object]:
    probe = PtyProbe("failure")
    try:
        ready = probe.start()
        probe.send(sgr(0, 11, 5))
        end = time.monotonic() + 1.0
        while not probe.handler_errors and time.monotonic() < end:
            probe.read_once(0.002)
            probe.parse_markers()
            probe.check_alive()
        if len(probe.handler_errors) != 1 or "injected pointer handler failure" not in probe.handler_errors[0].get("message", ""):
            raise AssertionError(f"injected pointer handler failure was not isolated: {probe.handler_errors}")
        status = probe.finish()
        return {"mode": "failure", "ready": ready, "status": status, "handlerErrors": probe.handler_errors}
    finally:
        probe.close()


def run_signal() -> dict[str, object]:
    probe = PtyProbe("signal")
    try:
        ready = probe.start()
        os.kill(probe.child_pid, signal.SIGTERM)
        end = time.monotonic() + 2.0
        while probe.child_status is None and time.monotonic() < end:
            probe.read_once(0.01)
            probe.parse_markers()
            waited, status = os.waitpid(probe.child_pid, os.WNOHANG)
            if waited == probe.child_pid:
                probe.child_status = status
        if probe.child_status is None:
            raise TimeoutError("SIGTERM did not shut down the renderer")
        while probe.pty_open:
            probe.read_once(0.02)
            probe.parse_markers()
        probe.raw_path.write_bytes(probe.captured)
        status = json.loads(probe.status_path.read_text("utf-8"))
        if not os.WIFEXITED(probe.child_status) or os.WEXITSTATUS(probe.child_status) != 0:
            raise AssertionError(f"SIGTERM renderer exited abnormally: {probe.child_status}")
        if status.get("exitReason") != "signal:SIGTERM" or status.get("rawMode", {}).get("restored") is not True:
            raise AssertionError(f"SIGTERM restoration failed: {status}")
        return {"mode": "signal", "ready": ready, "status": status, "artifacts": {"terminalCapture": str(probe.raw_path)}}
    finally:
        probe.close()


def run_job_control() -> dict[str, object]:
    probe = PtyProbe("job-control")
    try:
        ready = probe.start()
        os.kill(probe.child_pid, signal.SIGTSTP)
        stop_deadline = time.monotonic() + 2.0
        stopped_status: int | None = None
        while time.monotonic() < stop_deadline:
            probe.read_once(0.002)
            probe.parse_markers()
            waited, status = os.waitpid(probe.child_pid, os.WNOHANG | os.WUNTRACED)
            if waited == probe.child_pid:
                if os.WIFSTOPPED(status):
                    stopped_status = status
                    break
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    probe.child_status = status
                    raise AssertionError(f"renderer exited instead of suspending: {status}")
        if stopped_status is None:
            raise TimeoutError("SIGTSTP did not suspend the PTY child")
        suspended = next((phase for phase in probe.phases if phase.get("phase") == "suspended"), None)
        if not isinstance(suspended, dict) or suspended.get("rawMode") is not False or suspended.get("useMouse") is not False:
            raise AssertionError(f"job-control suspension did not release terminal modes: {probe.phases}")
        before_continue_modes = mode_transitions(bytes(probe.captured))
        if not any(code.endswith("l") and "1002" in code for code in before_continue_modes):
            raise AssertionError(f"mouse tracking was not reset before SIGTSTP: {before_continue_modes}")

        os.kill(probe.child_pid, signal.SIGCONT)
        probe.wait_for(PHASE, lambda: any(phase.get("phase") == "resumed" for phase in probe.phases))
        resumed = next((phase for phase in probe.phases if phase.get("phase") == "resumed"), None)
        if not isinstance(resumed, dict) or resumed.get("rawMode") is not True or resumed.get("useMouse") is not True:
            raise AssertionError(f"SIGCONT did not restore terminal modes: {probe.phases}")
        probe.send(b"q")
        status = probe.finish(quit_with_key=False)
        modes = mode_transitions(bytes(probe.captured))
        if not any(code.endswith("h") and "1002" in code for code in modes[ len(before_continue_modes): ]):
            raise AssertionError(f"mouse mode did not re-enable after SIGCONT: {modes}")
        return {
            "mode": "job-control",
            "ready": ready,
            "stoppedStatus": stopped_status,
            "status": status,
            "mouseModeTransitions": modes,
            "artifacts": {"terminalCapture": str(probe.raw_path), "lifecycle": str(probe.status_path)},
        }
    finally:
        probe.close()


def main() -> int:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    results = [run_enabled(), run_disabled(), run_all_motion(), run_failure(), run_signal(), run_job_control()]
    summary = {
        "ticket": "T084",
        "environment": {"os": os.uname().sysname, "release": os.uname().release, "machine": os.uname().machine,
                        "pty": "Linux kernel PTY", "term": "xterm-256color", "columns": 300, "rows": 40,
                        "emulator": "not present; PTY receives injected protocol bytes"},
        "matrix": [
            {"name": "Linux kernel PTY / OpenTUI 0.5.11", "result": "tested", "scope": "parser, renderer hit-test and lifecycle; not an emulator"},
            {"name": "SIGTSTP/SIGCONT wrapper around CliRenderer.suspend/resume", "result": "tested", "scope": "synthetic job-control signals through local PTY; product app still must own this signal policy"},
            {"name": "tmux 3.6a", "result": "not independently qualified", "scope": "installed, outer terminal identity unknown; no mouse injection/capture at client boundary"},
            {"name": "GNU Screen 4.09.01", "result": "not qualified", "scope": "installed; no attached physical terminal mouse path"},
            {"name": "SSH / OpenSSH 9.6p1", "result": "not qualified", "scope": "client present; no controlled named remote endpoint or direct terminal capture"},
            {"name": "WezTerm / Kitty / xterm / foot", "result": "not installed", "scope": "no emulator-specific claim"},
        ],
        "runs": results,
    }
    output = ARTIFACTS / "summary.json"
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(output), "runs": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
