#!/usr/bin/env python3
"""Production diagnostics/filter/jump and last-buffer/scratch lifecycle regressions."""
import fcntl
import os
from pathlib import Path
import pty
import runpy
import struct
import subprocess
import tempfile
import termios

ROOT = Path(__file__).resolve().parents[2]
helpers = runpy.run_path(str(ROOT / 'tests/e2e/t127-problems-live-diagnostics-pty.py'))
read_for, read_until = helpers['read_for'], helpers['read_until']
OUT = ROOT / '.artifacts/e2e/diagnostics'
OUT.mkdir(parents=True, exist_ok=True)

def launch(workspace, args):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
    child = subprocess.Popen(['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), *args], cwd=workspace,
        env=dict(os.environ, HOME=str(workspace), TERM='xterm-256color', XI_UI_TEST_MARKERS='1'),
        stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    captured = bytearray()
    read_until(master, captured, b'XI_WORKBENCH_READY', 10)
    return master, child, captured

def send(master, captured, keys, seconds=.4):
    before = len(captured)
    os.write(master, keys)
    read_for(master, captured, seconds)
    return captured[before:]

def cleanup(master, child, captured, name):
    (OUT / f'{name}.ansi').write_bytes(captured)
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)

with tempfile.TemporaryDirectory(prefix='xi-diagnostics-pty-') as temporary:
    workspace = Path(temporary)
    config = workspace / '.config/xi'
    config.mkdir(parents=True)
    (config / 'languages.toml').write_text('[[language]]\nname = "typescript"\nfile-types = ["ts"]\nlanguage-servers = ["typescript"]\nauto-format = false\n')
    source = workspace / 'main.ts'
    original = 'export {};\n\nconst x: string = 2;\n'
    source.write_text(original)
    (workspace / 'package.json').write_text('{}\n')
    (workspace / 'tsconfig.json').write_text('{"compilerOptions":{"strict":true,"noUnusedLocals":true}}\n')
    master, child, captured = launch(workspace, ['main.ts'])
    try:
        read_until(master, captured, b'2322:', 30)
        read_until(master, captured, b'6133:', 10)
        assert '├─'.encode() in captured and '└─'.encode() in captured
        assert b'Xi: terminal too small' not in captured
        send(master, captured, b' d')
        assert b'Diagnostics' in captured
        empty = send(master, captured, b'zzzz-no-such-diagnostic')
        assert b'No matches' in empty
        send(master, captured, b'\x1b')
        assert source.read_text() == original, 'cancel preserves the document'
        send(master, captured, b' d2322')
        send(master, captured, b'\r')
        send(master, captured, b'iZ\x1b')
        send(master, captured, b':w\r', 1)
        assert source.read_text() == original.replace('const x', 'const Zx'), 'Enter jumps to diagnostic UTF-16 column'
        send(master, captured, b':q\r')
        child.wait(timeout=5)
        assert child.returncode == 0
    finally: cleanup(master, child, captured, 'diagnostics')

    (workspace / 'file.txt').write_text('file content\n')
    for dirty in [False, True]:
        master, child, captured = launch(workspace, [])
        try:
            if dirty: send(master, captured, b'iKEEP\x1b')
            send(master, captured, b' ffile.txt', 1.5)
            send(master, captured, b'\r')
            send(master, captured, b':q\r')
            if dirty:
                assert child.poll() is None, 'dirty scratch survives opening and closing a file'
                rejected = send(master, captured, b':q\r')
                assert child.poll() is None and b'unsaved changes' in rejected
                send(master, captured, b':qa!\r')
            child.wait(timeout=5)
            assert child.returncode == 0, 'closing last file exits without a spare scratch buffer'
        finally: cleanup(master, child, captured, f'scratch-{dirty}')
print('Diagnostics PTY passed live inline errors, filtering, cancel, UTF-16 jump, last-buffer quit and clean/dirty scratch behavior')
