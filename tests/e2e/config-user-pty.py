#!/usr/bin/env python3
"""Prove canonical config paths and precedence in source or a staged release PTY."""
import argparse
import fcntl
import importlib.util
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("startup", ROOT / "tests/support/startup-pty.py")
assert spec is not None and spec.loader is not None
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)
RESPONSES = startup.RESPONSES
parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path)
args = parser.parse_args()
command = [str(args.binary.resolve())] if args.binary else ["bun", "run", str(ROOT / "apps/xi/src/main.ts")]


def wait_for(master: int, output: bytearray, needle: bytes, replied: list[int]) -> None:
    deadline = time.monotonic() + 8
    while needle not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            output.extend(os.read(master, 65536))
            for index, (query, response) in enumerate(RESPONSES):
                count = output.count(query)
                if count > replied[index]:
                    os.write(master, response * (count - replied[index]))
                    replied[index] = count
    if needle not in output:
        raise AssertionError(f"missing {needle!r}: {bytes(output[-1200:])!r}")


def case(name: str, use_xdg: bool, user: str, expected: str, *, legacy: str = "", workspace: str = "", cli: str = "", open_config: bool = False, theme_conflict: bool = False) -> None:
    with tempfile.TemporaryDirectory(prefix=f"xi-config-{name}-") as temporary:
        root = Path(temporary)
        home_config = root / ".config" / "xi" / "config.toml"
        xdg_config = root / "xdg" / "xi" / "config.toml"
        chosen = xdg_config if use_xdg else home_config
        chosen.parent.mkdir(parents=True)
        chosen.write_text(user)
        if theme_conflict:
            (chosen.parent / "state.json").write_text('{"theme":"xi-dark"}\n')
        if use_xdg:
            home_config.parent.mkdir(parents=True)
            home_config.write_text('[editor]\nline-number = "absolute"\n')
        if legacy:
            (root / ".xi.toml").write_text(legacy)
        if workspace:
            local = root / ".helix" / "config.toml"
            local.parent.mkdir()
            local.write_text(workspace)
        extra = []
        if cli:
            cli_path = root / "explicit.toml"
            cli_path.write_text(cli)
            extra = ["-c", str(cli_path)]
        source = root / "user-config.txt"
        source.write_text("one\ntwo\n")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
        env = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_")) and key != "XDG_CONFIG_HOME"}
        env.update(HOME=temporary, TERM="xterm-256color", COLORTERM="truecolor", XI_UI_TEST_MARKERS="1")
        if use_xdg:
            env["XDG_CONFIG_HOME"] = str(root / "xdg")
        child = subprocess.Popen([*command, *extra, str(source)], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = bytearray()
        replied = [0] * len(RESPONSES)
        try:
            wait_for(master, output, b"XI_WORKBENCH_READY", replied)
            marker = f'XI_EDITOR_CONFIG {{"enabled":true,"lineNumber":"{expected}"}}'.encode()
            if marker not in output:
                raise AssertionError(f"{name} did not apply {expected}: {bytes(output[-1200:])!r}")
            if theme_conflict:
                wait_for(master, output, b"\x1b[48;2;252;252;250m", replied)
            if open_config:
                os.write(master, b":config-open")
                wait_for(master, output, b'"source":":config-open"', replied)
                os.write(master, b"\r")
                wait_for(master, output, f'XI_CONFIG_OPEN {{"path":"{chosen}"'.encode(), replied)
            os.write(master, b":")
            wait_for(master, output, b'"source":":"', replied)
            os.write(master, b"qa!")
            wait_for(master, output, b'"source":":qa!"', replied)
            os.write(master, b"\r")
            wait_for(master, output, b"XI_TEARDOWN", replied)
            child.wait(timeout=5)
            if child.returncode != 0:
                raise AssertionError(f"{name} exited {child.returncode}")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)


case("home", False, '[editor]\nline-number = "relative"\n', "relative")
case("xdg", True, 'theme = "xi-light"\n[editor]\nline-number = "relative"\n', "relative",
     legacy='[editor]\nline-number = "absolute"\n', open_config=True, theme_conflict=True)
case("cli", True, '[editor]\nline-number = "relative"\n', "absolute",
     cli='[editor]\nline-number = "absolute"\n[editor.workspace-trust]\nlevel = "insecure"\n', workspace='[editor]\nline-number = "relative"\n')
case("workspace", False, '[editor]\nline-number = "relative"\n[editor.workspace-trust]\nlevel = "insecure"\n', "absolute",
     workspace='[editor]\nline-number = "absolute"\n')
print("T036 production PTY passed HOME/XDG config, legacy/CLI/workspace precedence and config-open")
