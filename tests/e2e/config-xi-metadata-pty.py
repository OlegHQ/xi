#!/usr/bin/env python3
"""Exercise canonical [xi] metadata through the launched editor."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROFILE = re.compile(rb"XI_CONFIG_PROFILE (\{[^\r\n]*\})")


with tempfile.TemporaryDirectory(prefix="xi-t036-xi-metadata-pty-") as temporary:
    workspace = Path(temporary)
    (workspace / "main.txt").write_text("hello\n", encoding="utf-8")
    config = workspace / ".config" / "xi" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[xi]\nschema-version = 1\nprofile = \"xi\"\nmotion-trail = \"off\"\n[xi.sidebar]\nvisible = false\nwidth = 34\npanel = \"search\"\n[xi.mouse]\nmodifier = \"shift\"\n[xi.selection]\nlimit = 20\nhistory-limit = 3\n[xi.hints]\ndelay-ms = 17\n[xi.search]\ndebounce-ms = 7\nmax-visible-results = 25\n[xi.aliases]\nxi-test = \"config.reload\"\n[xi.keys.search-panel.space]\nz = \"sidebar.toggle\"\n[keys.normal]\nC-s = \":write\"\nx = \":write\"\n[keys.insert]\nC-s = \":write\"\ny = \":write\"\n[keys.select]\nC-s = \":write\"\nz = \":write\"\n", encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": temporary, "XDG_CONFIG_HOME": "", "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "main.txt"],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 10
        while b"XI_WORKBENCH_READY" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_WORKBENCH_READY" not in captured:
            raise SystemExit(f"workbench did not start\n{captured[-4000:]!r}")
        deadline = time.monotonic() + 5
        profile = None
        while profile is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
            match = PROFILE.search(captured)
            if match is not None:
                profile = json.loads(match.group(1))
        if profile != {"profile": "xi", "schemaVersion": 1, "motionTrail": "off", "motionGhost": False, "mouseModifier": "shift", "selectionLimit": 20, "selectionHistoryLimit": 3, "hintsDelayMs": 17, "searchDebounceMs": 7, "searchMaxVisibleResults": 25}:
            raise SystemExit(f"canonical xi metadata did not reach the production host: {profile!r}")
        sidebar_match = re.search(rb"XI_SIDEBAR_CONFIG (\{[^\r\n]*\})", captured)
        sidebar = None if sidebar_match is None else json.loads(sidebar_match.group(1))
        if sidebar != {"visible": False, "panel": "search", "width": 34}:
            raise SystemExit(f"canonical xi.sidebar did not reach the production sidebar: {sidebar!r}")
        os.write(master, b" s")
        deadline = time.monotonic() + 5
        while b'XI_SIDEBAR_VISIBILITY {"visible":true}' not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b'XI_SIDEBAR_VISIBILITY {"visible":true}' not in captured:
            raise SystemExit("default normal key map did not open the sidebar")
        os.write(master, b" z")
        deadline = time.monotonic() + 5
        while b'XI_SIDEBAR_VISIBILITY {"visible":false}' not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b'XI_SIDEBAR_VISIBILITY {"visible":false}' not in captured:
            raise SystemExit(f"canonical xi.keys panel map did not close the sidebar\n{captured[-5000:]!r}")
        os.write(master, b"x")
        deadline = time.monotonic() + 5
        while b"XI_SAVE_POLICY" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"XI_SAVE_POLICY" not in captured:
            raise SystemExit(f"canonical Helix key maps did not reach the production save path\n{captured[-4000:]!r}")
        save_count = captured.count(b"XI_SAVE_POLICY")
        os.write(master, b"iy")
        deadline = time.monotonic() + 5
        while captured.count(b"XI_SAVE_POLICY") <= save_count and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if captured.count(b"XI_SAVE_POLICY") <= save_count:
            raise SystemExit("[keys.insert] did not reach the production save path")
        save_count = captured.count(b"XI_SAVE_POLICY")
        os.write(master, b"\x1bvz")
        deadline = time.monotonic() + 5
        while captured.count(b"XI_SAVE_POLICY") <= save_count and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if captured.count(b"XI_SAVE_POLICY") <= save_count:
            raise SystemExit(f"[keys.select] did not reach the production save path\n{captured[-5000:]!r}")
        os.write(master, b"\x1b")
        time.sleep(0.05)
        os.write(master, b":xi-test\r")
        deadline = time.monotonic() + 5
        while b'XI_CONFIG_RELOAD {"ok":true' not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b'XI_CONFIG_RELOAD {"ok":true' not in captured:
            raise SystemExit(f"canonical xi.aliases did not reach the production command path\n{captured[-4000:]!r}")
        time.sleep(0.1)
        os.write(master, b"\x1b")
        time.sleep(0.05)
        os.write(master, b" ")
        deadline = time.monotonic() + 0.15
        while b"Prefix <Sp" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.01)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        if b"Prefix <Sp" not in captured:
            raise SystemExit(f"canonical xi.hints.delay-ms did not reach the production help surface\n{captured[-4000:]!r}")
        os.write(master, b"\x1bq")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise SystemExit(f"Xi exited {child.returncode}\n{captured[-8000:]!r}")

print("T036 production PTY passed canonical xi metadata, runtime settings, xi.sidebar, and xi.aliases")
