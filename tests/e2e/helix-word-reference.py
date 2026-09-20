#!/usr/bin/env python3
"""Read actual Helix word selections through :pipe-to in an isolated real PTY."""
import fcntl, json, os, pty, select, struct, subprocess, tempfile, termios, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/selection-fixes'
OUT.mkdir(parents=True, exist_ok=True)
cases = [
    ('word', 'one two three\nnext line\n', 0, 'w', 1),
    ('count', 'one two three\nnext line\n', 0, 'w', 2),
    ('line-end', 'one two\nnext line\n', 4, 'w', 1),
    ('blank-lines', 'one\n\nnext line\n', 0, 'w', 1),
    ('indent', 'one\n    next line\n', 0, 'w', 1),
    ('whitespace', '    word next\n', 0, 'w', 1),
    ('middle-word', 'sample next\n', 2, 'w', 1),
    ('punctuation', 'word.foo next\n', 0, 'w', 2),
    ('long-word', 'word.foo next\n', 0, 'W', 1),
    ('end', 'one two three\n', 0, 'e', 1),
    ('end-count', 'one two three\n', 0, 'e', 2),
    ('backward', 'one two three\n', 8, 'b', 1),
    ('backward-count', 'one two three\n', 8, 'b', 2),
    ('unicode', '😀😀 next\n', 0, 'w', 1),
    ('combining', 'e\u0301clair next\n', 0, 'w', 1),
    ('last-word', 'last\n', 0, 'w', 1),
]
results = []
for name, text, origin, key, count in cases:
    with tempfile.TemporaryDirectory(prefix='xi-helix-reference-') as tmp:
        cwd = Path(tmp)
        (cwd / 'input.txt').write_text(text)
        (cwd / 'config.toml').write_text('')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=tmp, TERM='xterm-256color')
        child = subprocess.Popen(['hx', '--config', str(cwd / 'config.toml'), 'input.txt'], cwd=tmp, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        raw = bytearray()
        def drain(seconds):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([master], [], [], .02)[0]:
                    try: data = os.read(master, 65536)
                    except OSError: break
                    raw.extend(data)
                    if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
                    if b'\x1b[?u' in data: os.write(master, b'\x1b[?0u')
                    if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        try:
            drain(.8)
            os.write(master, ((f'{origin}l' if origin else '') + (str(count) if count != 1 else '') + key).encode())
            drain(.08)
            os.write(master, b':pipe-to cat > selected.txt\r')
            drain(.2)
            (OUT / f'helix-{name}.vt').write_bytes(raw)
            selected = (cwd / 'selected.txt').read_text()
            results.append(dict(name=name, text=text, origin=origin, key=key, count=count, selected=selected))
            os.write(master, b':q!\r')
            drain(.05)
        finally:
            child.terminate()
            child.wait(timeout=3)
            os.close(master)
        (OUT / f'helix-{name}.vt').write_bytes(raw)
result = dict(version=subprocess.check_output(['hx', '--version'], text=True).strip(), cases=results)
(OUT / 'helix-word-reference.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
expected = json.loads((ROOT / 'tests/workbench/helix-word-reference.json').read_text())
assert result == expected, 'Helix selection behavior changed; inspect the captured reference before updating it'
print(f"{len(results)} actual {result['version']} selections match the checked-in reference")
