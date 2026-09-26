#!/usr/bin/env python3
"""An empty automatic completion is retried after LSP indexing, then accepted."""
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
COMPLETION = '''    if message.get("method") == "textDocument/didOpen":
        document_text = message["params"]["textDocument"]["text"]
    if message.get("method") == "textDocument/didChange":
        document_text = message["params"]["contentChanges"][-1]["text"]
    if message.get("method") == "textDocument/completion":
        assert message["params"]["context"]["triggerKind"] in (1, 3)
        character = message["params"]["position"]["character"]
        items = [{"label": "$stdout", "textEdit": {"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": character}}, "newText": "$stdout"}}] if indexed and character == len(document_text) else []
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"isIncomplete": True, "items": items}}).encode()
        sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
        sys.stdout.buffer.flush()
        if not indexed:
            indexed = True
            import time
            time.sleep(.15)
            body = json.dumps({"jsonrpc": "2.0", "method": "$/progress", "params": {"token": "indexing", "value": {"kind": "end"}}}).encode()
            sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
            sys.stdout.buffer.flush()
        continue
'''

with tempfile.TemporaryDirectory(prefix='xi-completion-indexing-') as temporary:
    root = Path(temporary)
    config = root / '.config/xi/config.toml'
    config.parent.mkdir(parents=True)
    config.write_text('[editor]\nauto-format = false\n[editor.word-completion]\nenable = false\n')
    source = root / 'main.ts'
    source.write_text('')
    fake_bin = root / 'bin'
    fake_bin.mkdir()
    server = fake_bin / 'typescript-language-server'
    protocol = PROTOCOL.replace('while True:\n', 'indexed = False\ndocument_text = \"\"\nwhile True:\n', 1)
    protocol = protocol.replace('    if message.get("method") == "exit":', COMPLETION + '    if message.get("method") == "exit":')
    protocol = protocol.replace('"textDocumentSync": 1', '"textDocumentSync": 1, "completionProvider": {}')
    server.write_text(protocol)
    server.chmod(0o700)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 25, 100, 0, 0))
    env = dict(os.environ, HOME=temporary, XDG_CONFIG_HOME=str(root / '.config'), TERM='xterm-256color', XI_UI_TEST_MARKERS='0', PATH=str(fake_bin) + os.pathsep + os.environ['PATH'])
    child = subprocess.Popen(['bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(source)], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    screen = Screen(25, 100)

    def wait_for(predicate, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                screen.feed(os.read(master, 65536))
            if predicate():
                return
        raise AssertionError([screen.row_text(row) for row in range(1, 26)])

    try:
        wait_for(lambda: any('main.ts' in screen.row_text(row) for row in range(1, 26)))
        os.write(master, b'i$stdo')
        wait_for(lambda: any('$stdout' in screen.row_text(row) for row in range(1, 26)))
        os.write(master, b'u')
        wait_for(lambda: '$stdou' in screen.row_text(1))
        # Let the retrigger response replace the old menu before accepting it.
        deadline = time.monotonic() + .3
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                screen.feed(os.read(master, 65536))
        os.write(master, b'\x0e\t')
        wait_for(lambda: '$stdout' in screen.row_text(1))
        os.write(master, b'\x1b:w\r')
        wait_for(lambda: source.read_text() == '$stdout\n')
        os.write(master, b'$ax')
        wait_for(lambda: '$stdoutx' in screen.row_text(1))
        os.write(master, b'\x00')
        wait_for(lambda: any('No completions' in screen.row_text(row) for row in range(1, 26)))
        os.write(master, b'\x1b:q!\r')
        child.wait(timeout=8)
        assert child.returncode == 0
        assert source.read_text() == '$stdout\n', repr(source.read_text())
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
print('Completion indexing PTY passed: startup retry, synchronized incomplete-list retrigger, saved $stdout, and a visible empty-list message.')
