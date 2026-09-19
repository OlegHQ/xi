import os, pty, select, subprocess, tempfile, time, fcntl, termios, struct
from pathlib import Path
ROOT = Path('/home/snowbear/projects/xi')
def drain(m, t):
    end = time.monotonic() + t; out = bytearray()
    while time.monotonic() < end:
        r, _, _ = select.select([m], [], [], 0.05)
        if r:
            try: out.extend(os.read(m, 65536))
            except OSError: break
    return out
def descendants(pid):
    out = subprocess.run(['ps', '-eo', 'pid,ppid,args'], capture_output=True, text=True).stdout.splitlines()[1:]
    rows = [l.split(None, 2) for l in out]
    found, frontier = [], {pid}
    while frontier:
        nxt = set()
        for p, pp, args in rows:
            if int(pp) in frontier: nxt.add(int(p)); found.append(args)
        frontier = nxt
    return found
with tempfile.TemporaryDirectory(prefix='xi-lsp-') as tmp:
    ws = Path(tmp) / 'ws'; (ws / 'src').mkdir(parents=True)
    (ws / 'src' / 'alpha.py').write_text('def alpha_function(x):\n    return x\n\nalpha_function(1)\n')
    (ws / 'src' / 'beta.ts').write_text('export const betaValue = 1;\nconst other = betaValue;\n')
    (ws / 'package.json').write_text('{}'); (ws / 'pyproject.toml').write_text('')
    markers = Path(tmp) / 'markers.log'
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    env = dict(os.environ, TERM='xterm-256color', HOME=tmp, XI_UI_TEST_MARKERS='1')
    child = subprocess.Popen(['bash', '-c', f'exec bun run {ROOT}/apps/xi/src/main.ts 2>{markers}'], cwd=ws, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    drain(master, 3)
    os.write(master, b' f'); drain(master, 0.5); os.write(master, b'alpha'); drain(master, 1.0); os.write(master, b'\r'); drain(master, 0.8)
    os.write(master, b'jjj'); drain(master, 6); os.write(master, b' vo'); out = drain(master, 4); os.write(master, b'\x1b'); drain(master, 0.5)
    print('python outline shows symbol:', b'alpha_function' in out.replace(b'alpha_function(1)', b''))
    print('after python outline:', [a[:70] for a in descendants(child.pid) if 'pyright' in a or 'typescript-language' in a])
    os.write(master, b' f'); drain(master, 0.5); os.write(master, b'beta'); drain(master, 1.0); os.write(master, b'\r'); drain(master, 0.8)
    os.write(master, b'j$b'); drain(master, 6); os.write(master, b' vo'); out = drain(master, 4); os.write(master, b'\x1b'); drain(master, 0.5)
    print('ts outline shows symbol:', b'other' in out.replace(b'const other', b''))
    print('after ts outline:', [a[:70] for a in descendants(child.pid) if 'pyright' in a or 'typescript-language' in a])
    os.write(master, b'\x1b:qa!\r'); drain(master, 6)
    if child.poll() is None: child.kill()
    child.wait()
    print('exit', child.returncode)
    print('\n'.join(l[:160] for l in markers.read_text(errors='replace').splitlines() if 'xi:' in l or 'TEARDOWN' in l or 'DIAGNOST' in l or 'DEFINITION' in l or 'LANGUAGE' in l or 'LSP' in l)[:2500])
