#!/usr/bin/env python3
"""A signature popup mounted before lazy LSP startup must display the live response."""
import fcntl
import os
from pathlib import Path
import pty
import runpy
import select
import struct
import subprocess
import tempfile
import termios
import time

from terminal_screen import Screen

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = runpy.run_path(str(ROOT / 'tests/support/lsp-ready-pty.py'))['SERVER']
SIGNATURE = '''    if message.get("method") == "textDocument/signatureHelp":
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"signatures": [{"label": "max(...values: number[]): number", "documentation": "SIGNATURE_DOCUMENTATION"}], "activeSignature": 0}}).encode()
        sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
        sys.stdout.buffer.flush()
        continue
'''

with tempfile.TemporaryDirectory(prefix='xi-signature-visible-') as temporary:
    root = Path(temporary)
    config = root / '.config/xi/config.toml'
    config.parent.mkdir(parents=True)
    config.write_text('[editor.word-completion]\nenable = false\n')
    source = root / 'main.ts'
    source.write_text('Math.max(\n')
    fake_bin = root / 'bin'
    fake_bin.mkdir()
    server = fake_bin / 'typescript-language-server'
    protocol = PROTOCOL.replace('"textDocumentSync": 1', '"textDocumentSync": 1, "signatureHelpProvider": {"triggerCharacters": ["("]}')
    protocol = protocol.replace('    if message.get("method") == "exit":', SIGNATURE + '    if message.get("method") == "exit":')
    server.write_text(protocol)
    server.chmod(0o700)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 25, 100, 0, 0))
    env = dict(os.environ, HOME=temporary, XDG_CONFIG_HOME=str(root / '.config'), TERM='xterm-256color', XI_UI_TEST_MARKERS='0', PATH=str(fake_bin) + os.pathsep + os.environ['PATH'])
    child = subprocess.Popen(['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(source)], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    screen = Screen(25, 100)

    def wait_for(predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                screen.feed(os.read(master, 65536))
            if predicate():
                return
        raise AssertionError([screen.row_text(row) for row in range(1, 26)])

    try:
        wait_for(lambda: any('main.ts' in screen.row_text(row) for row in range(1, 26)))
        # Explicit help waits for lazy LSP readiness without timing the fake's startup.
        os.write(master, b'A\x1b[115;6u')
        wait_for(lambda: any('max(...values: number[]): number' in screen.row_text(row) for row in range(1, 26)))
        assert any('SIGNATURE_DOCUMENTATION' in screen.row_text(row) for row in range(1, 26))
        assert all('No language server available' not in screen.row_text(row) for row in range(1, 26))
        os.write(master, b'\x1b')
        time.sleep(.05)
        os.write(master, b'\x1b:q!\r')
        child.wait(timeout=8)
        assert child.returncode == 0
        assert source.read_text() == 'Math.max(\n'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
print('Signature visible PTY passed: lazy attachment updates the actual popup label and documentation.')
