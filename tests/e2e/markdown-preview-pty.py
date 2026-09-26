#!/usr/bin/env python3
"""Native Markdown toggle, scrolling, Visual yank, edits and buffer switches in the CLI."""
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
from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='xi-markdown-preview-') as temporary:
    workspace = Path(temporary)
    original = '# Preview title\n\nA **bold** word.\n\n| Name | Status |\n| --- | --- |\n| api | ready |\n\n' + ''.join(f'Paragraph {n}.\n\n' for n in range(80)) + '# End of preview\n'
    (workspace / 'preview.md').write_text(original)
    (workspace / 'other.txt').write_text('Other buffer plain text\n')
    (workspace / '.xi.toml').write_text('[xi.sidebar]\nvisible = false\n[editor]\nauto-format = false\n[editor.lsp]\nenable = false\n')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = dict(os.environ, HOME=temporary, XDG_CONFIG_HOME=str(workspace / '.config'), TERM='xterm-256color', XI_UI_TEST_MARKERS='1')
    command = [os.environ['XI_MARKDOWN_BINARY']] if 'XI_MARKDOWN_BINARY' in os.environ else ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts')]
    child = subprocess.Popen([*command, 'preview.md'], cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE)
    os.close(slave)
    screen = Screen(30, 100)
    diagnostics = bytearray()
    assert child.stderr is not None

    def text():
        return '\n'.join(screen.row_text(row) for row in range(1, 31))

    def pump(timeout=.03):
        for descriptor in select.select([master, child.stderr.fileno()], [], [], timeout)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError:
                data = b''
            if descriptor == master:
                screen.feed(data)
            else:
                diagnostics.extend(data)

    def wait_for(predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            pump()
        assert predicate(), f'Unexpected terminal state:\n{text()}\n{diagnostics[-3000:]!r}'

    def send(keys, predicate):
        os.write(master, keys)
        wait_for(predicate)

    try:
        wait_for(lambda: b'XI_WORKBENCH_READY' in diagnostics and '**bold**' in text())
        for _ in range(3):
            send(b' p', lambda: 'Markdown preview' in text() and 'Preview title' in text() and 'ready' in text() and '**bold**' not in text())
            send(b'G', lambda: 'End of preview' in text() and 'Preview title' not in text())
            send(b'gg', lambda: 'Preview title' in text() and 'End of preview' not in text())
            send(b' p', lambda: '**bold**' in text() and 'Markdown preview' not in text())
        send(b' p', lambda: 'Markdown preview' in text())
        send(b'V', lambda: 'SEL' in text())
        send(b'y', lambda: 'NOR' in text())
        send(b'i', lambda: 'INS' in text() and 'Markdown preview' not in text())
        os.write(master, b'X\x1b')
        wait_for(lambda: 'Markdown preview' in text())
        send(b' p', lambda: 'X# Preview title' in text())
        send(b'u', lambda: '# Preview title' in text() and 'X# Preview title' not in text())
        send(b':e other.txt\r', lambda: 'Other buffer plain text' in text())
        os.write(master, b' p')
        wait_for(lambda: 'Markdown preview requires a Markdown file' in text())
        assert 'Markdown preview ·' not in text()
        send(b':e preview.md\r', lambda: '**bold**' in text())
        os.write(master, b':wq\r')
        child.wait(timeout=5)
        assert child.returncode == 0, diagnostics.decode(errors='replace')
        assert (workspace / 'preview.md').read_text() == original
        assert b'Orphan text error' not in diagnostics and b'uncaught' not in diagnostics
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
print('Markdown preview CLI PTY passed toggles, gg/G, Visual yank, source editing, undo and non-Markdown guard')
