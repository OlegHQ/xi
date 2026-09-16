#!/usr/bin/env python3
"""Exercise the pinned OpenTUI renderer with terminal bytes through a kernel PTY."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import math
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
ARTIFACTS = ROOT / ".artifacts" / "input" / "pty"
EVENT_MARKER = b"XI_EVENT "
READY_MARKER = b"XI_READY "


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("legacy", "kitty", "all"), default="all", nargs="?")
    parser.add_argument("--timeout-seconds", type=float, default=12.0)
    parser.add_argument("--utf8-gap-ms", type=float)
    args = parser.parse_args()
    if args.timeout_seconds <= 0 or args.timeout_seconds > 60:
        parser.error("timeout-seconds must be in (0, 60]")
    return args


def set_winsize(fd: int, columns: int = 80, rows: int = 24) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def assert_subset(expected: object, actual: object, label: str) -> None:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise AssertionError(f"{label}: expected object, got {actual!r}")
        for key, value in expected.items():
            if key not in actual:
                raise AssertionError(f"{label}.{key}: missing from actual event {actual!r}")
            assert_subset(value, actual[key], f"{label}.{key}")
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            raise AssertionError(f"{label}: expected {len(expected)} items, got {actual!r}")
        for index, value in enumerate(expected):
            assert_subset(value, actual[index], f"{label}[{index}]")
        return
    if expected != actual:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def parse_marker(captured: bytearray, marker: bytes, start: int = 0) -> tuple[dict[str, object] | None, int]:
    position = captured.find(marker, start)
    if position < 0:
        return None, start
    end = captured.find(b"\r\n", position)
    if end < 0:
        return None, start
    value = json.loads(captured[position + len(marker):end].decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Invalid {marker.decode().strip()} marker: {value!r}")
    return value, end + 2


class PtyProbe:
    def __init__(self, mode: str, timeout_seconds: float, utf8_gap_ms: float):
        self.mode = mode
        self.timeout_seconds = timeout_seconds
        self.utf8_gap_ms = utf8_gap_ms
        self.captured = bytearray()
        self.events: list[dict[str, object]] = []
        self.latencies: list[dict[str, object]] = []
        self.event_scan_position = 0
        self.master_fd = -1
        self.child_pid = -1
        self.child_status: int | None = None
        self.pty_open = False
        self.deadline = 0.0
        self.status_path = ARTIFACTS / f"{mode}-status.json"
        self.raw_path = ARTIFACTS / f"{mode}.ansi"

    def start(self) -> dict[str, object]:
        self.status_path.unlink(missing_ok=True)
        self.raw_path.unlink(missing_ok=True)
        self.child_pid, self.master_fd = pty.fork()
        if self.child_pid == 0:
            child_env = os.environ.copy()
            child_env["TERM"] = "xterm-256color"
            child_env["COLORTERM"] = "truecolor"
            os.execvpe(
                "bun",
                ["bun", "run", "spikes/input/terminal-probe.ts", self.mode],
                child_env,
            )
        self.pty_open = True
        set_winsize(self.master_fd)
        self.deadline = time.monotonic() + self.timeout_seconds
        ready = self.wait_for_marker(READY_MARKER)
        if ready.get("mode") != self.mode or ready.get("rawMode") is not True:
            raise RuntimeError(f"Renderer readiness check failed: {ready}")
        expected_kitty = self.mode == "kitty"
        if ready.get("kittyKeyboard") is not expected_kitty:
            raise RuntimeError(f"Unexpected Kitty keyboard mode for {self.mode}: {ready}")
        return ready

    def wait_for_marker(self, marker: bytes) -> dict[str, object]:
        scan_position = 0
        while time.monotonic() < self.deadline:
            value, next_position = parse_marker(self.captured, marker, scan_position)
            if value is not None:
                return value
            scan_position = next_position
            self.read_once(min(0.002, max(0.0, self.deadline - time.monotonic())))
            self.parse_events()
            self.check_process_alive()
        raise TimeoutError(f"Timed out waiting for {marker.decode().strip()} in {self.raw_path}")

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
        if not chunk:
            self.pty_open = False
        else:
            self.captured.extend(chunk)

    def parse_events(self) -> None:
        while True:
            event, next_position = parse_marker(self.captured, EVENT_MARKER, self.event_scan_position)
            if event is None:
                return
            self.events.append(event)
            self.event_scan_position = next_position

    def check_process_alive(self) -> None:
        if self.child_status is not None:
            raise RuntimeError(f"Renderer exited before the PTY test completed: {self.child_status}")
        waited_pid, status = os.waitpid(self.child_pid, os.WNOHANG)
        if waited_pid == self.child_pid:
            self.child_status = status

    def send_and_wait(self, data: bytes, label: str, target_event_count: int) -> None:
        before = len(self.events)
        sent_at = time.monotonic_ns()
        os.write(self.master_fd, data)
        while len(self.events) < target_event_count and time.monotonic() < self.deadline:
            self.read_once(min(0.002, max(0.0, self.deadline - time.monotonic())))
            self.parse_events()
            self.check_process_alive()
        if len(self.events) < target_event_count:
            raise TimeoutError(f"{self.mode} {label}: expected event {target_event_count}, observed {len(self.events)}")
        received_at = time.monotonic_ns()
        for index in range(before, target_event_count):
            event = self.events[index]
            self.latencies.append({
                "input": label,
                "eventIndex": index,
                "eventKind": event.get("kind"),
                "elapsedMicroseconds": round((received_at - sent_at) / 1000, 3),
                "boundary": "parent PTY write to observed OpenTUI event marker",
            })

    def send_split_utf8(self, target_event_count: int, expected_count: int) -> None:
        before = len(self.events)
        sent_at = time.monotonic_ns()
        os.write(self.master_fd, b"\xc3")
        if self.utf8_gap_ms > 0:
            time.sleep(self.utf8_gap_ms / 1000)
        os.write(self.master_fd, b"\xa9")
        while len(self.events) < target_event_count + expected_count - 1 and time.monotonic() < self.deadline:
            self.read_once(min(0.002, max(0.0, self.deadline - time.monotonic())))
            self.parse_events()
            self.check_process_alive()
        expected_total = target_event_count + expected_count - 1
        if len(self.events) < expected_total:
            raise TimeoutError(f"{self.mode} split UTF-8: expected {expected_total} total events, observed {len(self.events)}")
        received_at = time.monotonic_ns()
        for index in range(before, expected_total):
            event = self.events[index]
            self.latencies.append({
                "input": f"UTF-8 split across PTY writes ({self.utf8_gap_ms:g}ms gap)",
                "eventIndex": index,
                "eventKind": event.get("kind"),
                "elapsedMicroseconds": round((received_at - sent_at) / 1000, 3),
                "boundary": "parent PTY writes to observed OpenTUI event marker",
            })

    def send_no_new_event(self, data: bytes, label: str) -> None:
        before = len(self.events)
        os.write(self.master_fd, data)
        settle_until = min(self.deadline, time.monotonic() + 0.06)
        while time.monotonic() < settle_until:
            self.read_once(min(0.002, max(0.0, settle_until - time.monotonic())))
            self.parse_events()
            self.check_process_alive()
        if len(self.events) != before:
            raise AssertionError(f"{self.mode} {label}: duplicate report delivered another event")

    def verify_ctrl_c_did_not_exit(self) -> None:
        self.check_process_alive()
        if self.child_status is not None or self.status_path.exists():
            raise AssertionError("Renderer exited on Ctrl-C before receiving the later quit key")

    def finish(self, expected: list[dict[str, object]]) -> dict[str, object]:
        self.send_and_wait(b"q", "normal quit", len(expected))
        while self.child_status is None and time.monotonic() < self.deadline:
            self.read_once(min(0.05, max(0.0, self.deadline - time.monotonic())))
            self.parse_events()
            waited_pid, status = os.waitpid(self.child_pid, os.WNOHANG)
            if waited_pid == self.child_pid:
                self.child_status = status
        if self.child_status is None:
            raise TimeoutError(f"{self.mode} renderer did not shut down after q")
        self.read_trailing_output()
        self.raw_path.write_bytes(self.captured)
        if not os.WIFEXITED(self.child_status) or os.WEXITSTATUS(self.child_status) != 0:
            raise RuntimeError(f"Renderer exit was not clean: status={self.child_status}; output={self.raw_path}")
        if not self.status_path.exists():
            raise RuntimeError(f"Renderer did not write lifecycle status: {self.status_path}")
        status_value = json.loads(self.status_path.read_text(encoding="utf-8"))
        if not isinstance(status_value, dict):
            raise RuntimeError(f"Invalid renderer status: {status_value!r}")
        if status_value.get("exitReason") != "q" or status_value.get("rendererDestroyed") is not True:
            raise AssertionError(f"Expected q to dispose renderer: {status_value}")
        if status_value.get("targetDestroyed") is not True:
            raise AssertionError(f"Expected mouse target disposal: {status_value}")
        raw_mode = status_value.get("rawMode")
        if not isinstance(raw_mode, dict) or raw_mode.get("restored") is not True:
            raise AssertionError(f"PTY raw mode was not restored: {status_value}")
        if len(self.events) != len(expected):
            raise AssertionError(f"Expected {len(expected)} OpenTUI events, got {len(self.events)}: {self.events}")
        assert_subset(expected, self.events, f"{self.mode}.events")
        self.check_paste_single_event()
        self.write_traces()
        return {
            "mode": self.mode,
            "eventCount": len(self.events),
            "ctrlCObservedWithoutExit": True,
            "status": status_value,
            "latency": summarize(self.latencies),
            "artifacts": {
                "terminalCapture": str(self.raw_path),
                "eventTrace": str(ARTIFACTS / f"{self.mode}.events.json"),
                "latencyTrace": str(ARTIFACTS / f"{self.mode}.latency.json"),
            },
        }

    def check_paste_single_event(self) -> None:
        pastes = [event for event in self.events if event.get("kind") == "paste"]
        if len(pastes) != 1:
            raise AssertionError(f"Expected exactly one paste event, got {pastes!r}")
        if pastes[0].get("payloadHex") != "781b5b410a71" or pastes[0].get("length") != 6:
            raise AssertionError(f"Pasted key-looking bytes were modified: {pastes[0]!r}")

    def read_trailing_output(self) -> None:
        end_time = time.monotonic() + 0.25
        while self.pty_open and time.monotonic() < end_time:
            readable, _, _ = select.select([self.master_fd], [], [], min(0.05, end_time - time.monotonic()))
            if not readable:
                continue
            self.read_once(0.1)
            self.parse_events()

    def write_traces(self) -> None:
        (ARTIFACTS / f"{self.mode}.events.json").write_text(
            json.dumps(self.events, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (ARTIFACTS / f"{self.mode}.latency.json").write_text(
            json.dumps({"boundary": "parent PTY write to observed OpenTUI event marker", "samples": self.latencies,
                        "summaryMicroseconds": summarize(self.latencies)}, indent=2) + "\n",
            encoding="utf-8",
        )

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
            if self.captured:
                self.raw_path.write_bytes(self.captured)
            os.close(self.master_fd)
            self.master_fd = -1


def summarize(samples: list[dict[str, object]]) -> dict[str, float | int]:
    values = sorted(float(item["elapsedMicroseconds"]) for item in samples)
    if not values:
        return {"sampleCount": 0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}

    def percentile(value: float) -> float:
        index = max(0, math.ceil(value * len(values)) - 1)
        return round(values[index], 3)

    return {
        "sampleCount": len(values),
        "p50": percentile(0.50),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
        "max": round(values[-1], 3),
    }


def expected_events(mode: str, utf8_gap_ms: float) -> list[dict[str, object]]:
    utf8_events: list[dict[str, object]]
    if mode == "legacy" and utf8_gap_ms >= 20:
        utf8_events = [
            {"kind": "key", "name": "C", "meta": True, "shift": True, "source": "raw", "rawHex": "1b43"},
            {"kind": "key", "name": "", "source": "raw", "rawHex": "1b29"},
        ]
    else:
        utf8_events = [
            {"kind": "key", "name": "é", "source": "raw", "rawHex": "c3a9", "eventType": "press"},
        ]
    common_end = [
        {"kind": "paste", "payloadHex": "781b5b410a71", "length": 6},
        {"kind": "mouse", "eventType": "down", "button": 0, "column0": 5, "row0": 2,
         "source": "renderer", "ctrl": False, "alt": False, "shift": False},
        *utf8_events,
        {"kind": "blur"},
        {"kind": "focus"},
        {"kind": "key", "name": "q", "source": "raw", "eventType": "press"},
    ]
    if mode in ("legacy", "legacy-guarded"):
        return [
            {"kind": "key", "name": "escape", "source": "raw", "rawHex": "1b", "eventType": "press"},
            {"kind": "key", "name": "x", "meta": True, "source": "raw", "rawHex": "1b78", "eventType": "press"},
            {"kind": "key", "name": "tab", "ctrl": False, "source": "raw", "rawHex": "09"},
            {"kind": "key", "name": "tab", "ctrl": False, "source": "raw", "rawHex": "09"},
            {"kind": "key", "name": "c", "ctrl": True, "source": "raw", "rawHex": "03"},
            *common_end,
        ]
    return [
        {"kind": "key", "name": "escape", "source": "kitty", "rawHex": "1b5b323775", "eventType": "press"},
        {"kind": "key", "name": "x", "meta": True, "source": "kitty", "rawHex": "1b5b3132303b3375", "eventType": "press"},
        {"kind": "key", "name": "x", "source": "kitty", "rawHex": "1b5b3132303b313a3275", "eventType": "repeat", "repeated": True},
        {"kind": "key", "name": "tab", "ctrl": False, "source": "kitty", "rawHex": "1b5b3975"},
        {"kind": "key", "name": "i", "ctrl": True, "source": "kitty", "rawHex": "1b5b3130353b3575"},
        {"kind": "key", "name": "c", "ctrl": True, "source": "kitty", "rawHex": "1b5b39393b3575", "eventType": "press"},
        {"kind": "key", "name": "c", "ctrl": True, "source": "kitty", "rawHex": "1b5b39393b353a3375", "eventType": "release"},
        *common_end,
    ]


def run_mode(mode: str, timeout_seconds: float, utf8_gap_ms: float) -> dict[str, object]:
    probe = PtyProbe(mode, timeout_seconds, utf8_gap_ms)
    try:
        ready = probe.start()
        target_count = 0
        if mode in ("legacy", "legacy-guarded"):
            probe.send_and_wait(b"\x1b", "delayed Escape", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1bx", "Alt-x", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x09", "legacy Tab", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x09", "legacy Ctrl-I collision", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x03", "legacy Ctrl-C", target_count + 1)
        else:
            probe.send_and_wait(b"\x1b[27u", "Kitty Escape", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[120;3u", "Kitty Alt-x", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[120;1:2u", "Kitty x repeat", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[9u", "Kitty Tab", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[105;5u", "Kitty Ctrl-I", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[99;5u", "Kitty Ctrl-C", target_count + 1)
            target_count += 1
            probe.send_and_wait(b"\x1b[99;5:3u", "Kitty Ctrl-C release", target_count + 1)
        target_count += 1
        probe.verify_ctrl_c_did_not_exit()
        probe.send_and_wait(b"\x1b[200~x\x1b[A\nq\x1b[201~", "bracketed paste", target_count + 1)
        target_count += 1
        probe.send_and_wait(b"\x1b[<0;6;3M", "SGR mouse press", target_count + 1)
        target_count += 1
        utf8_expected_count = 2 if mode == "legacy" and utf8_gap_ms >= 20 else 1
        probe.send_split_utf8(target_count + 1, utf8_expected_count)
        target_count += utf8_expected_count
        probe.send_and_wait(b"\x1b[O", "focus-out report", target_count + 1)
        target_count += 1
        probe.send_no_new_event(b"\x1b[O", "repeated focus-out")
        probe.send_and_wait(b"\x1b[I", "focus-in report", target_count + 1)
        target_count += 1
        probe.send_no_new_event(b"\x1b[I", "repeated focus-in")
        result = probe.finish(expected_events(mode, utf8_gap_ms))
        result["utf8Boundary"] = {
            "gapMilliseconds": utf8_gap_ms,
            "preservedOneCharacter": utf8_expected_count == 1,
            "guardEnabled": mode == "legacy-guarded",
        }
        result["ready"] = ready
        return result
    finally:
        probe.close()


def main() -> int:
    args = parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    if args.mode == "all":
        runs = [
            ("legacy", 25.0 if args.utf8_gap_ms is None else args.utf8_gap_ms),
            ("kitty", 0.0 if args.utf8_gap_ms is None else args.utf8_gap_ms),
            ("legacy-guarded", 25.0 if args.utf8_gap_ms is None else args.utf8_gap_ms),
        ]
    else:
        mode = args.mode
        default_gap = 25.0 if mode == "legacy" else 0.0
        runs = [(mode, default_gap if args.utf8_gap_ms is None else args.utf8_gap_ms)]
    results = [run_mode(mode, args.timeout_seconds, gap) for mode, gap in runs]
    output_path = ARTIFACTS / "summary.json"
    output_path.write_text(json.dumps({"ticket": "T006", "runs": results}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(output_path), "runs": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
