#!/usr/bin/env python3
"""Measure packaged Xi spawn-to-ready in a responsive PTY."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("startup", ROOT / "tests/support/startup-pty.py")
assert SPEC is not None and SPEC.loader is not None
STARTUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STARTUP)
RESPONSES = STARTUP.RESPONSES


def sample(command: list[str], root: Path, file: bool, width: int, height: int) -> dict:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("XI_", "OTUI_"))}
    env.update(HOME=str(root), XDG_CONFIG_HOME=str(root / "config"),
               XDG_STATE_HOME=str(root / "state"), TERM="xterm-256color",
               XI_UI_TEST_MARKERS="1", XI_STARTUP_TRACE="1")
    fixture = root / "probe.txt"
    fixture.write_text("startup_probe_7Q\nsecond line\n")
    output = bytearray()
    replied = [0] * len(RESPONSES)
    started = time.perf_counter_ns()
    child = subprocess.Popen([*command, *([str(fixture)] if file else [])],
                             cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    try:
        deadline = time.monotonic() + 5
        marker_ms = None
        file_visible_at_marker = False
        while marker_ms is None or (file and not STARTUP.visible_marker(output, "startup_probe_7Q")):
            if time.monotonic() >= deadline or child.poll() is not None:
                raise RuntimeError(f"Xi did not become ready: {bytes(output)[-1000:]!r}")
            if not select.select([master], [], [], .01)[0]:
                continue
            try:
                output.extend(os.read(master, 65536))
            except OSError as error:
                raise RuntimeError(f"PTY closed before ready: {bytes(output)[-1000:]!r}") from error
            for i, (query, response) in enumerate(RESPONSES):
                count = output.count(query)
                if count > replied[i]:
                    os.write(master, response * (count - replied[i]))
                    replied[i] = count
            if marker_ms is None and b"XI_WORKBENCH_READY" in output:
                marker_ms = (time.perf_counter_ns() - started) / 1e6
                file_visible_at_marker = STARTUP.visible_marker(output, "startup_probe_7Q")
        wall_ms = (time.perf_counter_ns() - started) / 1e6
        trace = {key.decode(): float(value) for key, value in
                 re.findall(rb"XI_STARTUP_TRACE ([a-z-]+) ([0-9.]+)", output)}
        status = Path(f"/proc/{child.pid}/status").read_text()
        rss = int(re.search(r"^VmRSS:\s+(\d+)", status, re.M)[1])
        stat = Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()
        cpu_ms = (int(stat[11]) + int(stat[12])) * 1000 / os.sysconf("SC_CLK_TCK")
        return {"file": file, "wall_ms": wall_ms, "marker_ms": marker_ms,
                "file_visible_at_marker": file_visible_at_marker, "trace_ms": trace,
                "output_bytes": len(output), "cpu_ms": cpu_ms, "rss_kib": rss}
    finally:
        child.kill()
        child.wait()
        os.close(master)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "dist/xi")
    parser.add_argument("--source", action="store_true", help="measure bun run apps/xi/src/main.ts")
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--width", type=int, default=120)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.samples < 1 or args.width < 40 or args.height < 12:
        parser.error("samples must be positive and terminal at least 40x12")
    command = [shutil.which("bun"), "run", "apps/xi/src/main.ts"] if args.source else [str(args.binary.resolve())]
    rows = []
    with tempfile.TemporaryDirectory(prefix="xi-startup-ready-") as temporary:
        root = Path(temporary)
        for index in range(args.samples + 1):
            for file in (False, True):
                row = sample(command, root, file, args.width, args.height)
                if index:
                    rows.append(row)
    def percentile(values: list[float], fraction: float) -> float:
        return sorted(values)[math.ceil(len(values) * fraction) - 1]
    summary = {name: {key: percentile([row["wall_ms"] for row in rows if row["file"] == file], fraction)
                      for key, fraction in (("p50", .5), ("p95", .95), ("p99", .99), ("max", 1))}
               for name, file in (("no_file", False), ("small_file", True))}
    report = {"command": command,
              "binary_sha256": None if args.source else hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "platform": platform.platform(), "cpu_count": os.cpu_count(),
              "samples_per_case": args.samples,
              "boundary": f"process spawn to XI_WORKBENCH_READY in responsive {args.width}x{args.height} PTY",
              "summary_ms": summary, "runs": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
