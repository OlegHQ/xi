#!/usr/bin/env python3
"""Closing the final buffer retains the workbench; only quit-all exits."""
import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / '.artifacts/e2e/quit-buffer.ansi'

with tempfile.TemporaryDirectory(prefix='xi-quit-buffer-') as temporary:
    target = Path(temporary) / 'file.txt'
    target.write_text('unchanged\n')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    child = subprocess.Popen(['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)],
        cwd=temporary, env={**os.environ, 'HOME': temporary, 'TERM': 'xterm-256color', 'XI_UI_TEST_MARKERS': '1'},
        stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    captured = bytearray()

    def read_for(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    return

    def send(value):
        os.write(master, value)
        read_for(0.35)

    try:
        deadline = time.monotonic() + 10
        while b'XI_WORKBENCH_READY' not in captured and time.monotonic() < deadline:
            read_for(0.05)
        assert b'XI_WORKBENCH_READY' in captured, captured[-2000:]
        send(b'iDIRTY')
        send(b'\x1b')
        send(b':q\r')
        assert child.poll() is None, ':q lost dirty work'
        assert b'unsaved changes' in captured, captured[-2000:]
        send(b':q!\r')
        assert child.poll() is None, ':q! exited instead of closing the buffer'
        assert b'XI_WORKBENCH_VIEW_CLOSED' in captured, captured[-2000:]
        send(b':q\r')
        assert child.poll() is None, ':q in an empty workbench exited'
        send(b':qa\r')
        child.wait(timeout=5)
        assert child.returncode == 0
        assert target.read_text() == 'unchanged\n', 'forced close unexpectedly saved changes'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
        ARTIFACT.write_bytes(captured)
print('quit-buffer PTY passed dirty protection, last-buffer close, empty :q, :qa exit and disk preservation')
