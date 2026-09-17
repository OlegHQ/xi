#!/usr/bin/env python3
"""PF10 60s real idle-CPU measurement for the IDLE budget (owner: platform, ticket: T114).

Spawns the actual production CLI under a PTY, waits for it to reach a usable frame, then
samples its own /proc/<pid>/stat CPU ticks before and 60 real seconds later with no input
delivered at all — a genuine idle window, not a synthetic proxy. min_samples for this budget
is 1, so a single real trial is sufficient, but this still records raw before/after ticks so
the computation is independently checkable.

Limitation, stated plainly: this workspace has no package.json/tsconfig, so no language-server
worker starts for this fixture. "editor+workers" idle CPU with a real language server attached
is not measured here — only the editor's own idle CPU is.
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLK_TCK = os.sysconf('SC_CLK_TCK')


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def cpu_ticks(pid: int) -> int:
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    # utime is field 14, stime field 15 counting the whole stat line from 1; after the ')'
    # split, index 0 is field 3, so utime is index 11, stime index 12.
    return int(fields[11]) + int(fields[12])


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError('usage: t114-idle-trial.py OUTPUT.json')
    if sys.platform != 'linux':
        raise ValueError('this PF10 idle adapter is pinned to Linux /proc/[pid]/stat')
    with tempfile.TemporaryDirectory(prefix='xi-t114-idle-') as temporary:
        workspace = Path(temporary)
        source = workspace / 'main.ts'
        source.write_text('const value = 1;\n', encoding='utf-8')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        environment = os.environ.copy()
        environment.update({'TERM': 'xterm-256color', 'HOME': str(workspace), 'XI_UI_TEST_MARKERS': '1'})
        child = subprocess.Popen(
            ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(source)],
            cwd=str(workspace), env=environment, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        )
        os.close(slave)
        captured = bytearray()
        try:
            deadline = time.monotonic() + 10
            while b'XI_WORKBENCH_READY' not in captured and time.monotonic() < deadline:
                read_for(master, captured, 0.05)
            if b'XI_WORKBENCH_READY' not in captured:
                raise ValueError('the CLI never reached a ready frame')
            started_wall = time.monotonic()
            before_ticks = cpu_ticks(child.pid)
            # Genuinely idle: no input written to the master at all for 60 real seconds.
            read_for(master, captured, 60.0)
            elapsed_wall = time.monotonic() - started_wall
            after_ticks = cpu_ticks(child.pid)
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
            os.close(master)

        cpu_seconds = (after_ticks - before_ticks) / CLK_TCK
        cpu_core_percent = (cpu_seconds / elapsed_wall) * 100
        report = {
            'schema_version': 1,
            'classification': 'diagnostic',
            'reference_host': False,
            'fixture': 'PF10-idle-cli',
            'diagnostic_only': True,
            'limitation': 'no package.json/tsconfig in this fixture; no language-server worker started, so this measures the editor process alone, not editor+workers',
            'collected_at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
            'command': ['python3', 'bench/performance/t114-idle-trial.py', sys.argv[1]],
            'environment': {'platform': sys.platform, 'clk_tck': CLK_TCK},
            'before_ticks': before_ticks,
            'after_ticks': after_ticks,
            'elapsed_wall_seconds': elapsed_wall,
            'cpu_core_percent_mean': cpu_core_percent,
        }
        path = Path(sys.argv[1])
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            raise ValueError('output already exists; preserve earlier observations with a new path')
        path.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
