#!/usr/bin/env python3
"""Diagnostic startup comparison; output-byte evidence, never a release gate.

Use a freshly compiled Xi binary and the pinned development Neovim oracle.
All children use isolated configuration and the same 120x40 responsive PTY.
"""
from __future__ import annotations

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
import random
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("oracle_pty", ROOT / "tests/oracle/pty-ui.py")
assert SPEC is not None and SPEC.loader is not None
ORACLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORACLE)
RESPONSES = (*ORACLE.TERMINAL_QUERY_RESPONSES,
             (b"\x1b]10;?\x07", b"\x1b]10;rgb:eeee/eeee/eeee\x07"))
# Keep the marker away from the cursor cell (Xi paints a block glyph there).
FIXTURE = b"x startup_probe_7Q\nsecond line\n"


def visible_marker(data: bytes | bytearray, marker: str) -> bool:
    # OSC terminates at BEL or ST. The older oracle helper's greedy OSC pattern
    # can swallow the first frame through a later cursor-color OSC. Do not use
    # that matcher for startup timing (retained trace-final is the reproduction).
    cleaned = re.sub(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", b"", bytes(data))
    cleaned = re.sub(rb"\x1b[P_^].*?\x1b\\", b"", cleaned, flags=re.S)
    cleaned = ORACLE.ANSI_CSI_SEQUENCE.sub(b"", cleaned)
    try:
        text = cleaned.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return False
    return marker in text


def summary(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {key: ordered[max(0, math.ceil(len(ordered) * q) - 1)]
            for key, q in (("p50", .5), ("p95", .95), ("p99", .99), ("max", 1))}


def trial(name: str, command: list[str], root: Path, output: Path, index: int,
          trace: bool = False, edit: bytes = b"Z") -> dict:
    home = root / name
    home.mkdir(exist_ok=True)
    fixture = root / "probe.txt"
    fixture.write_bytes(FIXTURE)
    empty = name == "xi-empty"
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("XI_", "OTUI_", "HELIX_", "NVIM_"))}
    env.update(HOME=str(home), TERM="xterm-256color", COLORTERM="truecolor", LC_ALL="C.UTF-8")
    for key in ("CONFIG", "DATA", "CACHE", "STATE"):
        env[f"XDG_{key}_HOME"] = str(home / key.lower())
    if trace:
        env["XI_STARTUP_TRACE"] = "1"
    if empty:
        env["XI_UI_TEST_MARKERS"] = "1"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    captured = bytearray()
    counts = [0] * len(RESPONSES)
    arrivals = []
    started = time.perf_counter_ns()
    child = subprocess.Popen(command + ([] if empty else [str(fixture)]), cwd=ROOT,
                             env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)

    def read_once(timeout: float = .01) -> bool:
        if not select.select([master], [], [], timeout)[0]:
            return True
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        captured.extend(chunk)
        arrivals.append({"ms": (time.perf_counter_ns() - started) / 1e6, "bytes": len(chunk)})
        for i, (query, reply) in enumerate(RESPONSES):
            occurrences = captured.count(query)
            if occurrences > counts[i]:
                os.write(master, reply * (occurrences - counts[i]))
                counts[i] = occurrences
        return True

    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not read_once():
                raise RuntimeError(f"{name}: exited before content: {bytes(captured)!r}")
            if empty:
                ready = b"XI_WORKBENCH_READY" in captured
            else:
                ready = (visible_marker(captured, "startup_probe_7Q")
                         and visible_marker(captured, "second line")
                         # Both editors paint their own cursor cell and keep the terminal's
                         # hardware cursor hidden while the buffer has focus.
                         and b"\x1b[?25l" in captured
                         and captured.rfind(b"\x1b[?2026l") >= captured.rfind(b"\x1b[?2026h"))
            if ready:
                break
        else:
            raise RuntimeError(f"{name}: content timeout: {bytes(captured)!r}")
        ready_ms = (time.perf_counter_ns() - started) / 1e6
        ready_bytes = len(captured)
        rss_status = Path(f"/proc/{child.pid}/status").read_text()
        rss = {key: int(re.search(rf"^{key}:\s+(\d+)", rss_status, re.M)[1])
               for key in ("VmRSS", "VmHWM")}
        stat = Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()
        cpu_ms = (int(stat[11]) + int(stat[12])) * 1000 / os.sysconf("SC_CLK_TCK")
        first_insert_ms = None
        if empty:
            os.write(master, b"q")
        else:
            # Sent immediately at the measured boundary; saved bytes prove admission.
            insertion_start = len(captured)
            insertion_time = time.perf_counter_ns()
            os.write(master, b"i" + edit)
            until = time.monotonic() + 5
            while time.monotonic() < until:
                read_once()
                if visible_marker(captured[insertion_start:], "INS" if name == "helix" else "INSERT"):
                    first_insert_ms = (time.perf_counter_ns() - insertion_time) / 1e6
                    break
            else:
                raise RuntimeError(f"{name}: first key did not enter Insert")
            escape_start = len(captured)
            os.write(master, b"\x1b")
            until = time.monotonic() + (0.1 if name == "neovim" else 5)
            while time.monotonic() < until:
                read_once()
                if name != "neovim" and visible_marker(captured[escape_start:], "NOR" if name == "helix" else "NORMAL"):
                    break
            if name != "neovim" and not visible_marker(captured[escape_start:], "NOR" if name == "helix" else "NORMAL"):
                raise RuntimeError(f"{name}: Escape did not return to Normal")
            os.write(master, b":wq\r")
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            read_once()
        child.wait(timeout=1)
        if child.returncode != 0:
            raise RuntimeError(f"{name}: exit {child.returncode}: {bytes(captured)!r}")
        if not empty and fixture.read_bytes() != edit + FIXTURE:
            raise RuntimeError(f"{name}: first input/save mismatch")
        trace_rows = re.findall(rb"XI_STARTUP_TRACE ([a-z-]+) ([0-9.]+)", captured)
        result = {"name": name, "index": index, "wall_ms": ready_ms,
                  "cpu_at_boundary_ms": cpu_ms, "first_insert_mode_ms": first_insert_ms,
                  "output_bytes_at_boundary": ready_bytes, "rss_kib": rss,
                  "exact_saved_bytes": not empty, "arrivals": arrivals,
                  "trace_ms": {key.decode(): float(value) for key, value in trace_rows}}
        if index <= 0 or trace:
            (output / f"{name}-{index}.ansi").write_bytes(captured)
        return result
    finally:
        if child.poll() is None:
            (output / f"{name}-{index}-incomplete.ansi").write_bytes(captured)
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--compiled", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--baseline-compiled", type=Path)
    parser.add_argument("--baseline-source", type=Path)
    parser.add_argument("--trace", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result_path = args.output / "comparison.json"
    if result_path.exists() or args.samples < 1:
        raise ValueError("use a fresh output directory and positive sample count")
    manifest = json.loads((ROOT / "tests/oracle/manifest.json").read_text())
    nvim = ROOT / ".artifacts/oracle" / manifest["oracle"]["binaryPath"]
    if hashlib.sha256(nvim.read_bytes()).hexdigest() != manifest["oracle"]["binarySha256"]:
        raise RuntimeError("Neovim oracle binary does not match pin")
    commands = {
        "xi-source": [shutil.which("bun"), "run", "apps/xi/src/main.ts"],
        "xi-compiled": [str(args.compiled.resolve())],
        "helix": [shutil.which("hx")],
        "neovim": [str(nvim), "--clean", "-u", "NONE", "-i", "NONE", "--noplugin"],
        "xi-empty": [shutil.which("bun"), "run", "apps/xi/src/main.ts"],
    }
    if args.baseline_source:
        commands["xi-baseline-source"] = [shutil.which("bun"), "run", str(args.baseline_source.resolve())]
    if args.baseline_compiled:
        commands["xi-baseline-compiled"] = [str(args.baseline_compiled.resolve())]
    paths = [*ROOT.glob("apps/**/*.ts"), *ROOT.glob("packages/**/*.ts"),
             ROOT / "bun.lock", *ROOT.glob("node_modules/@opentui/core/*bun*.js")]
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    rng = random.Random(20260916)
    rows = []
    with tempfile.TemporaryDirectory(prefix="xi-startup-profile-") as temporary:
        root = Path(temporary)
        warmups = [trial(name, cmd, root, args.output, 0, args.trace) for name, cmd in commands.items()]
        for index in range(1, args.samples + 1):
            names = list(commands)
            rng.shuffle(names)
            for name in names:
                rows.append(trial(name, commands[name], root, args.output, index, args.trace))
            print(f"paired block {index}/{args.samples}", flush=True)
    if any(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != value for path, value in hashes.items()):
        raise RuntimeError("sources changed during measurement")
    report = {"classification": "diagnostic", "platform": platform.platform(),
              "cpu_count": os.cpu_count(), "terminal": "responsive synthetic xterm-256color PTY 120x40",
              "boundary": "spawn to fixture lines + editor cursor visibility command + closed synchronized update in output stream",
              "empty_boundary": "Xi frame callback marker (separate, not compared with other editors)",
              "limitations": ["No complete terminal cell parser or physical pixel capture",
                              "Shared host; fresh process, warm filesystem; not a release gate",
                              "CPU from proc stat at boundary has scheduler tick resolution",
                              "RSS is main process at boundary; allocations and worker memory not measured"],
              "commands": commands, "source_hashes": hashes, "warmups": warmups, "trials": rows,
              "summary_ms": {name: summary([r["wall_ms"] for r in rows if r["name"] == name]) for name in commands}}
    result_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary_ms"], indent=2))


if __name__ == "__main__":
    main()
