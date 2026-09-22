#!/usr/bin/env python3
"""Sidebar toggle works from editor and panel focus through configured bindings."""
import fcntl
import os
import pty
import select
import sys
import struct
import subprocess
import tempfile
import termios
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / '.artifacts/e2e/sidebar-toggle.ansi'

with tempfile.TemporaryDirectory(prefix='xi-quit-buffer-') as temporary:
    chord = b' s'
    if '--remapped' in sys.argv:
        (Path(temporary) / '.xi.toml').write_text('[keys.normal.space]\ng = "sidebar.toggle"\n[keys.files-panel.space]\ng = "sidebar.toggle"\n')
        chord = b' g'
    if '--nested' in sys.argv:
        (Path(temporary) / '.xi.toml').write_text('[keys.normal.space.x.y]\nz = "sidebar.toggle"\n[keys.files-panel.space.x.y]\nz = "sidebar.toggle"\n')
        chord = b' xyz'
    if '--single' in sys.argv:
        (Path(temporary) / '.xi.toml').write_text('[keys.normal]\n"<F2>" = "sidebar.toggle"\n[keys.files-panel]\n"<F2>" = "sidebar.toggle"\n')
        chord = b'\x1bOQ'
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
        # The sidebar participates in the same Vim window graph: left from the leftmost
        # editor enters it, right returns to the preserved editor pane.
        send(b'\x17h')
        assert b'XI_EXPLORER_OPEN' in captured, captured[-2500:]
        prefix_start = len(captured)
        send(b'\x17')  # send() waits 350 ms, longer than the 250 ms help delay
        assert b'Prefix' not in captured[prefix_start:], captured[prefix_start:]
        send(b'l')
        send(b'iNAV')
        send(b'\x1b')
        send(chord)
        assert b'XI_SIDEBAR_VISIBILITY {"visible":false}' in captured, captured[-2500:]
        send(chord)
        assert b'XI_SIDEBAR_VISIBILITY {"visible":true}' in captured, captured[-2500:]
        # Reopened Files now owns focus; the same mapped chord must hide it again.
        send(chord)
        assert captured.count(b'XI_SIDEBAR_VISIBILITY {"visible":false}') == 2, captured[-2500:]
        send(b'iEDIT')
        send(b'\x1b')
        send(b':w\r')
        save_deadline = time.monotonic() + 5
        while target.read_text() != 'NAEDITVunchanged\n' and child.poll() is None and time.monotonic() < save_deadline:
            read_for(.05)
        assert target.read_text() == 'NAEDITVunchanged\n', f'unified sidebar/editor focus or hidden-sidebar edit mismatch: {target.read_text()!r}'
        send(b':qa\r')
        child.wait(timeout=5)
        assert child.returncode == 0
        state_path = Path(temporary) / '.xi.toml'
        state = tomllib.loads(state_path.read_text())
        assert state['xi']['sidebar']['visible'] is False, state
        if '--remapped' in sys.argv:
            assert state['keys']['normal']['space']['g'] == 'sidebar.toggle'
        if '--restore-search' in sys.argv:
            state_path.write_text(state_path.read_text() + 'editor.sidebar-panel = "search"\neditor.sidebar-width = 34\n')
        # Reuse the PTY for a new CLI process: first toggle must now show the saved hidden sidebar.
        new_master, new_slave = pty.openpty()
        os.close(master)
        master = new_master
        fcntl.ioctl(new_slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        child = subprocess.Popen(['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)],
            cwd=temporary, env={**os.environ, 'HOME': temporary, 'TERM': 'xterm-256color', 'XI_UI_TEST_MARKERS': '1'},
            stdin=new_slave, stdout=new_slave, stderr=new_slave)
        os.close(new_slave)
        captured.clear()
        deadline = time.monotonic() + 10
        while b'XI_WORKBENCH_READY' not in captured and time.monotonic() < deadline:
            read_for(.05)
        assert b'XI_WORKBENCH_READY' in captured
        send(chord)
        assert b'XI_SIDEBAR_VISIBILITY {"visible":true}' in captured, captured[-2500:]
        if '--restore-search' in sys.argv:
            assert b'XI_SEARCH_OPEN' in captured, captured[-2500:]
            send(b'\x1b')
            send(b'\x1b')
        send(b':qa\r')
        child.wait(timeout=5)
        assert tomllib.loads(state_path.read_text())['xi']['sidebar']['visible'] is True
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
        ARTIFACT.write_bytes(captured)
print('Sidebar toggle PTY passed editor/panel toggle and immediate editor input')
