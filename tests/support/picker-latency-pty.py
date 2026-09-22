#!/usr/bin/env python3
"""Measure source or packaged Space f prompt, filtered result and cancellation in a large repo."""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]


def fixture(root: Path) -> Path:
    workspace = root / "workspace"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    (workspace / "main.txt").write_text("main\n")
    (workspace / ".gitignore").write_text("vendor/\n")
    for directory in range(50):
        folder = workspace / f"src{directory:02d}"
        folder.mkdir()
        for number in range(100):
            (folder / f"file{number:03d}.txt").write_text("x\n")
    (workspace / "src00" / "needle_unique.txt").write_text("needle\n")
    (workspace / "src10" / ".gitignore").write_text("generated/\n")
    for parent, count in ((workspace / "vendor", 1000), (workspace / "src10" / "generated", 200)):
        parent.mkdir(parents=True)
        for number in range(count):
            (parent / f"junk{number:04d}.txt").write_text("ignored\n")
    return workspace


def sample(command: list[str], workspace: Path, home: Path) -> dict[str, float]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_"))}
    env.update(HOME=str(home), XDG_CONFIG_HOME="", TERM="xterm-256color", XI_UI_TEST_MARKERS="1")
    child = subprocess.Popen([*command, str(workspace / "main.txt")], cwd=workspace,
                             env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()

    def until(marker: bytes, timeout: float = 10) -> float:
        started = time.perf_counter_ns()
        deadline = time.monotonic() + timeout
        while marker not in output and time.monotonic() < deadline:
            if not select.select([master], [], [], .005)[0]:
                continue
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
        if marker not in output:
            raise RuntimeError(f"missing {marker!r}: {bytes(output[-1000:])!r}")
        return (time.perf_counter_ns() - started) / 1_000_000

    try:
        startup = until(b"XI_WORKBENCH_READY")
        output.clear()
        os.write(master, b" f")
        prompt = until(b"Files  >")
        output.clear()
        os.write(master, b"needle")
        result = until(b"needle_unique.txt")
        target = workspace / "src00" / "needle_unique.txt"
        preview = result + until(f'"path":"{target}"}}'.encode())
        status = Path(f"/proc/{child.pid}/status").read_text()
        rss_kib = int(re.search(r"^VmRSS:\s+(\d+)", status, re.M)[1])
        stat = Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()
        cpu_ms = (int(stat[11]) + int(stat[12])) * 1000 / os.sysconf("SC_CLK_TCK")
        output.clear()
        os.write(master, b"\x1b")
        cancel = until(b"XI_PICKER_CANCELLED")
        return {"startup_ms": startup, "prompt_ms": prompt, "result_ms": result,
                "preview_ms": preview, "cancel_ms": cancel, "cpu_ms": cpu_ms, "rss_kib": rss_kib}
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


def percentile(values: list[float], fraction: float) -> float:
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="store_true")
    parser.add_argument("--binary", type=Path, default=ROOT / "dist/xi")
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("samples must be positive")
    command = ["bun", "run", str(ROOT / "apps/xi/src/main.ts")] if args.source else [str(args.binary.resolve())]
    with tempfile.TemporaryDirectory(prefix="xi-picker-latency-") as temporary:
        root = Path(temporary)
        workspace = fixture(root)
        home = root / "home"
        config = home / ".config" / "xi" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text('[editor.workspace-trust]\nlevel = "insecure"\n')
        sample(command, workspace, home)  # warm module and filesystem caches
        runs = [sample(command, workspace, home) for _ in range(args.samples)]
    summary = {key: {name: percentile([run[key] for run in runs], fraction)
                     for name, fraction in (("p50", .5), ("p95", .95), ("p99", .99), ("max", 1))}
               for key in runs[0]}
    report = {"command": command, "samples": args.samples, "fixture": "5,002 source files, 1,200 ignored files, nested .gitignore, 120x40 PTY",
              "boundary": "write keys to matching terminal output", "summary": summary, "runs": runs}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
