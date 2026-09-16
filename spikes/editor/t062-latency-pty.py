#!/usr/bin/env python3
"""Measure PTY input to visible WorkbenchRenderable text on the local host."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import math
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / ".artifacts" / "performance" / "t062-input-output.json"
READY = b"XI_T062_LATENCY_READY "
STOPPED = b"XI_T062_LATENCY_STOPPED "
FRAME = b"XI_T062_LATENCY_FRAME "
CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)")
# OpenTUI normalizes printable key names to lowercase in this path. Keep the
# generated stream lowercase and omit q, which is the probe's quit key.
ALPHABET = "abcdefghijklmnoprstuvwxyz"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=10_000)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    args = parser.parse_args()
    if args.samples < 1 or args.samples > 10_000:
        parser.error("samples must be between 1 and 10000")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 600:
        parser.error("timeout-seconds must be in (0, 600]")
    return args


def set_winsize(fd: int, columns: int = 80, rows: int = 24) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def visible(data: bytes) -> bytes:
    """Remove terminal controls so text can be matched across SGR spans."""
    cleaned = OSC.sub(b"", data)
    cleaned = CSI.sub(b"", cleaned)
    cleaned = cleaned.replace(b"\r", b"")
    return bytes(byte for byte in cleaned if byte in (9, 10) or byte >= 32)


def marker(data: bytearray, prefix: bytes) -> dict[str, object] | None:
    start = data.find(prefix)
    if start < 0:
        return None
    end = data.find(b"\r\n", start)
    if end < 0:
        return None
    value = json.loads(data[start + len(prefix) : end].decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid marker {value!r}")
    return value


def next_key(state: int) -> tuple[int, str]:
    state = (state * 1_664_525 + 1_013_904_223) & 0xFFFFFFFF
    return state, ALPHABET[state % len(ALPHABET)]


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return round(ordered[index], 3)


def main() -> None:
    args = parse_args()
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    child, fd = pty.fork()
    if child == 0:
        environment = os.environ.copy()
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        os.execvpe("bun", ["bun", "run", "spikes/editor/t062-latency.ts"], environment)

    set_winsize(fd)
    captured = bytearray()
    deadline = time.monotonic() + args.timeout_seconds
    status: int | None = None

    def read_once(timeout: float) -> None:
        if timeout <= 0:
            return
        readable, _, _ = select.select([fd], [], [], timeout)
        if not readable:
            return
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        if chunk:
            captured.extend(chunk)

    try:
        ready: dict[str, object] | None = None
        while time.monotonic() < deadline and ready is None:
            read_once(min(0.01, max(0.0, deadline - time.monotonic())))
            ready = marker(captured, READY)
        if ready is None:
            raise TimeoutError("T062 latency renderer did not become ready")
        initial_version = ready.get("documentVersion")
        if not isinstance(initial_version, int):
            raise RuntimeError(f"T062 latency readiness omitted document version: {ready!r}")

        text = "_"
        latencies: list[float] = []
        state = 0x06206201
        previous_key = ""
        frame_scan_position = 0
        frame_versions: dict[int, str] = {}

        def scan_frames() -> None:
            nonlocal frame_scan_position
            while True:
                start = captured.find(FRAME, frame_scan_position)
                if start < 0:
                    return
                end = captured.find(b"\r\n", start)
                if end < 0:
                    return
                value = json.loads(captured[start + len(FRAME) : end].decode("utf-8"))
                if not isinstance(value, dict):
                    raise RuntimeError(f"invalid frame marker {value!r}")
                version = value.get("version")
                prefix = value.get("prefix")
                if isinstance(version, int) and isinstance(prefix, str):
                    frame_versions[version] = prefix
                frame_scan_position = end + 2

        for sample in range(args.samples):
            state, key = next_key(state)
            while key == previous_key:
                state, key = next_key(state)
            previous_key = key
            text = key + text
            # The final underscore is a cursor sentinel and is painted over by
            # the software cursor. The renderer reports the frame's visible
            # prefix after painting so this boundary does not depend on ANSI
            # stripping or terminal cursor movement.
            expected = text[:-1][:18]
            expected_version = initial_version + sample + 1
            started = time.monotonic_ns()
            written = os.write(fd, key.encode("ascii"))
            if written != 1:
                raise RuntimeError(f"short PTY write at sample {sample}: {written}")
            matched = False
            while time.monotonic() < deadline:
                scan_frames()
                rendered_prefix = frame_versions.get(expected_version)
                if rendered_prefix is not None and rendered_prefix.startswith(expected):
                    matched = True
                    break
                read_once(min(0.005, max(0.0, deadline - time.monotonic())))
            if not matched:
                raise TimeoutError(f"T062 latency sample {sample} did not render frame version {expected_version} prefix {expected!r}")
            latencies.append((time.monotonic_ns() - started) / 1_000_000)

        os.write(fd, b"q")
        while time.monotonic() < deadline:
            read_once(min(0.01, max(0.0, deadline - time.monotonic())))
            if marker(captured, STOPPED) is not None:
                break
            waited, child_status = os.waitpid(child, os.WNOHANG)
            if waited == child:
                status = child_status
                break
        if status is None:
            _, status = os.waitpid(child, 0)
        if status != 0:
            raise RuntimeError(f"T062 latency renderer exited with status {status}")
        p95 = percentile(latencies, 0.95)
        p99 = percentile(latencies, 0.99)
        within_target = p95 <= 8 and p99 <= 16
        summary = {
            "ticket": "T062",
            "fixture": "T062-INPUT-OUTPUT-01",
            "samples": len(latencies),
            "seed": "0x06206201",
            "geometry": ready,
            "boundary": "monotonic time around parent PTY write until a production WorkbenchRenderable frame marker reports the expected text prefix",
            "physicalDisplayExcluded": True,
            "latencyMilliseconds": {
                "p50": percentile(latencies, 0.50),
                "p95": p95,
                "p99": p99,
                "max": round(max(latencies), 3),
            },
            "targetMilliseconds": {"p95": 8, "p99": 16},
            "thresholdEvaluation": "within-target" if within_target else "over-target",
            "stableRunnerRequired": True,
            "environment": {"term": "xterm-256color", "python": sys.version.split()[0]},
        }
        ARTIFACT.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"T062 PTY input-output probe completed {len(latencies)} samples: p95={p95}ms p99={p99}ms target={summary['thresholdEvaluation']}")
    finally:
        if status is None:
            try:
                os.kill(child, 15)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
        os.close(fd)


if __name__ == "__main__":
    main()
