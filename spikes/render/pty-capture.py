#!/usr/bin/env python3
"""Drive the real OpenTUI CLI spike through a kernel PTY and retain VT output."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import termios
import time


ROOT = Path.cwd()
ARTIFACTS = ROOT / ".artifacts" / "t002" / "terminal"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", choices=("close", "error"))
    parser.add_argument("--width", type=int, default=80)
    parser.add_argument("--height", type=int, default=28)
    parser.add_argument("--timeout-seconds", type=float, default=12.0)
    args = parser.parse_args()
    if args.width < 40 or args.height < 10:
        parser.error("PTY dimensions must be at least 40x10")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 60:
        parser.error("timeout-seconds must be in (0, 60]")
    return args


def set_winsize(fd: int, width: int, height: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def read_json(path: Path) -> dict[str, object]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected JSON object in {path}")
    return value


def main() -> int:
    args = parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    ready_path = ARTIFACTS / f"{args.scenario}-ready.json"
    status_path = ARTIFACTS / f"{args.scenario}-status.json"
    output_path = ARTIFACTS / f"pty-{args.scenario}.ansi"
    for stale_path in (ready_path, status_path, output_path):
        stale_path.unlink(missing_ok=True)

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        child_env = os.environ.copy()
        child_env["TERM"] = "xterm-256color"
        child_env["COLORTERM"] = "truecolor"
        os.execvpe(
            "bun",
            ["bun", "run", "spikes/render/terminal-probe.ts", args.scenario],
            child_env,
        )

    set_winsize(master_fd, args.width, args.height)
    captured = bytearray()
    key_sent = False
    child_status: int | None = None
    pty_open = True
    deadline = time.monotonic() + args.timeout_seconds
    try:
        while time.monotonic() < deadline:
            readable = select.select([master_fd], [], [], 0.05)[0] if pty_open else []
            if readable:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    pty_open = False
                else:
                    if not chunk:
                        pty_open = False
                    else:
                        captured.extend(chunk)

            if not key_sent and ready_path.exists():
                ready = read_json(ready_path)
                if ready.get("width") != args.width or ready.get("height") != args.height:
                    raise RuntimeError(f"PTY reported unexpected dimensions: {ready}")
                if ready.get("rawMode") is not True:
                    raise RuntimeError(f"Renderer did not enter raw terminal mode: {ready}")
                os.write(master_fd, b"q" if args.scenario == "close" else b"e")
                key_sent = True

            waited_pid, waited_status = os.waitpid(child_pid, os.WNOHANG)
            if waited_pid == child_pid:
                child_status = waited_status
                break

        if child_status is None:
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            _, child_status = os.waitpid(child_pid, 0)
            raise TimeoutError(f"{args.scenario} PTY probe exceeded {args.timeout_seconds}s")

        # Read the final terminal restoration sequences after the child exits.
        while True:
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if not readable:
                break
            try:
                chunk = os.read(master_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            captured.extend(chunk)
    finally:
        os.close(master_fd)
        output_path.write_bytes(captured)

    if not key_sent:
        raise RuntimeError(f"The {args.scenario} PTY probe never reached its first frame")
    if child_status is None or not os.WIFEXITED(child_status) or os.WEXITSTATUS(child_status) != 0:
        raise RuntimeError(f"PTY process did not exit cleanly; raw output: {output_path}")
    if not status_path.exists():
        raise RuntimeError(f"Renderer did not write lifecycle status: {status_path}")

    status = read_json(status_path)
    if status.get("rendererDestroyed") is not True or status.get("viewportDestroyed") is not True:
        raise RuntimeError(f"Renderer resources were not disposed: {status}")
    terminal = status.get("terminal")
    if not isinstance(terminal, dict) or terminal.get("rawModeRestored") is not True:
        raise RuntimeError(f"Raw terminal mode was not restored: {status}")
    if args.scenario == "error" and status.get("renderError") != "injected terminal render failure":
        raise RuntimeError(f"Injected render failure was not observed: {status}")
    if args.scenario == "close" and status.get("exitReason") != "q":
        raise RuntimeError(f"Normal close key was not handled: {status}")

    for sequence, label in ((b"\x1b[?1049h", "alternate screen enter"), (b"\x1b[?1049l", "alternate screen restore")):
        if sequence not in captured:
            raise RuntimeError(f"Missing {label} sequence in {output_path}")
    if b"\x1b[?25l" not in captured or b"\x1b[?25h" not in captured:
        raise RuntimeError(f"Cursor visibility was not restored in {output_path}")

    print(json.dumps({
        "scenario": args.scenario,
        "size": f"{args.width}x{args.height}",
        "ptyBytes": len(captured),
        "childExit": os.WEXITSTATUS(child_status),
        "status": status,
        "rawOutput": str(output_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
