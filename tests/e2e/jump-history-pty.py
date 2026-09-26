#!/usr/bin/env python3
"""Pinned Neovim reference and real Xi sessions: Ctrl-O/I across process restarts."""
import fcntl
import json
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
with tempfile.TemporaryDirectory(prefix='xi-jump-history-') as temporary:
    workspace = Path(temporary)
    a, b = workspace / 'a.txt', workspace / 'b.txt'
    a.write_text('First origin\nFirst middle\nFirst end\n')
    b.write_text('Second origin\nSecond middle\nSecond end\n')
    (workspace / '.xi.toml').write_text('[xi]\nmotion-trail = "off"\n[xi.sidebar]\nvisible = false\n[editor.lsp]\nenable = false\n')
    env = dict(os.environ, HOME=temporary, XDG_CONFIG_HOME=str(workspace / '.config'), XDG_STATE_HOME=str(workspace / '.state'), TERM='xterm-256color', XI_UI_TEST_MARKERS='1')
    # :help jumplist / CTRL-O: ShaDa restores history at its newest entry.
    oracle = ROOT / '.artifacts/oracle/nvim-linux-arm64/bin/nvim'
    base = [str(oracle), '--headless', '-u', 'NONE', '--noplugin', '--cmd', "set shada='100", '-i', str(workspace / 'shada')]
    subprocess.run([*base, str(a), '-c', 'normal! G', '-c', f'edit {b}', '-c', 'normal! G', '-c', 'wshada!', '-c', 'qa!'], env=env, check=True, capture_output=True)
    output = workspace / 'oracle.json'
    lua = "local checkpoints={}; for _,key in ipairs({'<C-o>','<Tab>','<C-o>'}) do vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(key,true,false,true),'xt',false); table.insert(checkpoints,{path=vim.fn.expand('%:p'),line=vim.fn.line('.')}) end; vim.fn.writefile({vim.json.encode(checkpoints)}," + json.dumps(str(output)) + ")"
    subprocess.run([*base, str(a), '-c', 'lua ' + lua, '-c', 'qa!'], env=env, check=True, capture_output=True)
    assert json.loads(output.read_text()) == [{'path': str(b), 'line': 3}, {'path': str(a), 'line': 1}, {'path': str(b), 'line': 3}]
    command = [os.environ['XI_JUMP_BINARY']] if 'XI_JUMP_BINARY' in os.environ else ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts')]

    def session(actions):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
        child = subprocess.Popen([*command, 'a.txt'], cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        screen = Screen(24, 100)
        diagnostics = bytearray()
        assert child.stderr is not None

        def text():
            return '\n'.join(screen.row_text(row) for row in range(1, 25))

        def wait_for(predicate):
            deadline = time.monotonic() + 8
            while not predicate() and time.monotonic() < deadline:
                for descriptor in select.select([master, child.stderr.fileno()], [], [], .03)[0]:
                    try:
                        data = os.read(descriptor, 65536)
                    except OSError:
                        data = b''
                    if descriptor == master:
                        screen.feed(data)
                    else:
                        diagnostics.extend(data)
            assert predicate(), f'Terminal:\n{text()}\n{diagnostics[-3000:]!r}'

        def send(keys, expected):
            os.write(master, keys)
            wait_for(expected if callable(expected) else lambda: expected in text())

        try:
            wait_for(lambda: b'XI_WORKBENCH_READY' in diagnostics and 'First origin' in text())
            time.sleep(.15)
            actions(send, text)
            os.write(master, b':qa!\r')
            child.wait(timeout=5)
            assert child.returncode == 0, diagnostics.decode(errors='replace')
            assert b'cannot save jump' not in child.stderr.read()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)

    def initial(send, text):
        send(b'jj', 'First origin')
        send(b':e b.txt\r', 'Second origin')
        send(b'jj', 'Second origin')
    session(initial)
    history = workspace / '.state/xi/jumps.json'
    saved = json.loads(history.read_text())
    assert saved['entries'][-1] == {'path': str(b), 'line': 2, 'columnUtf16': 0}

    def restart(send, text):
        send(b'\x0f', 'Second origin')
        send(b'iX\x1b:w\r', lambda: 'XSecond end' in b.read_text())
        assert 'XSecond origin' not in b.read_text(), 'restored cursor must be on line three'
        send(b'u:w\r', lambda: 'XSecond end' not in b.read_text())
        send(b'\t', 'First origin')
        send(b'\x0f', 'Second origin')
    session(restart)
    b.unlink()

    def missing(send, text):
        send(b'\x0f', 'cannot jump to')
        send(b'\x0f', 'First origin')
        assert not b.exists(), 'jump history must not recreate deleted files'
    session(missing)
    history.write_text('{broken')
    session(lambda send, text: send(b'jiY\x1b:w\r', lambda: 'YFirst middle' in a.read_text()))
    assert history.read_text() == '{broken', 'invalid history must be preserved'
print('Persistent jump history: pinned Neovim restart, Ctrl-O/I, missing files and invalid state passed')
