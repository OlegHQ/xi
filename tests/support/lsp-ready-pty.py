#!/usr/bin/env python3
"""Measure source or packaged Xi from spawn to a ready LSP through a real PTY."""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import pty
import select
import stat
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = '''#!/usr/bin/env python3
import json
import sys
while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b"\\r\\n", b"\\n"):
            break
        key, _, value = line.partition(b":")
        if key.lower() == b"content-length":
            length = int(value.strip())
    if length is None:
        continue
    message = json.loads(sys.stdin.buffer.read(length))
    if message.get("method") == "exit":
        break
    if message.get("method") != "initialize" and "id" not in message:
        continue
    result = {"capabilities": {"positionEncoding": "utf-16", "textDocumentSync": 1}} if message.get("method") == "initialize" else None
    body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}, separators=(",", ":")).encode()
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
    sys.stdout.buffer.flush()
'''
MARKERS = (b"XI_WORKBENCH_READY", b"XI_LSP_SESSION_ROOT", b"XI_LSP_READY")


def sample(command: list[str], workspace: Path, home: Path, fake_bin: Path) -> dict[str, float]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_"))}
    env.update(HOME=str(home), XDG_CONFIG_HOME="", TERM="xterm-256color", XI_UI_TEST_MARKERS="1",
               PATH=f"{fake_bin}:{env.get('PATH', '')}")
    started = time.perf_counter_ns()
    child = subprocess.Popen([*command, str(workspace / "main.ts")], cwd=workspace,
                             env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    seen: dict[bytes, float] = {}
    try:
        deadline = time.monotonic() + 10
        while len(seen) < len(MARKERS) and time.monotonic() < deadline:
            if not select.select([master], [], [], .01)[0]:
                continue
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
            elapsed = (time.perf_counter_ns() - started) / 1_000_000
            for marker in MARKERS:
                if marker not in seen and marker in output:
                    seen[marker] = elapsed
        if len(seen) != len(MARKERS):
            raise RuntimeError(f"LSP did not become ready: {bytes(output[-1200:])!r}")
        ready, session, lsp = (seen[marker] for marker in MARKERS)
        return {"workbench_ms": ready, "lsp_session_after_ready_ms": session - ready,
                "lsp_ready_after_session_ms": lsp - session, "lsp_ready_after_workbench_ms": lsp - ready}
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


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
    with tempfile.TemporaryDirectory(prefix="xi-lsp-ready-") as temporary:
        root = Path(temporary)
        workspace, home, fake_bin = root / "workspace", root / "home", root / "bin"
        for directory in (workspace, home, fake_bin):
            directory.mkdir()
        (workspace / "package.json").write_text("{}\n")
        (workspace / "main.ts").write_text("const value = 1;\n")
        server = fake_bin / "typescript-language-server"
        server.write_text(SERVER)
        server.chmod(stat.S_IRWXU)
        sample(command, workspace, home, fake_bin)  # warm module and filesystem caches
        runs = [sample(command, workspace, home, fake_bin) for _ in range(args.samples)]
    summary = {key: {name: sorted(run[key] for run in runs)[math.ceil(args.samples * fraction) - 1]
                     for name, fraction in (("p50", .5), ("p95", .95), ("max", 1))} for key in runs[0]}
    report = {"command": command, "samples": args.samples, "fixture": "TypeScript file, immediate-response Python LSP, 120x40 PTY",
              "boundary": "spawn to marker output; LSP intervals measured from matching PTY bytes", "summary": summary, "runs": runs}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
