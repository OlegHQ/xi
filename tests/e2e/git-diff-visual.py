#!/usr/bin/env python3
"""Real xterm evidence for comparison layout, first-change focus and save after resize."""
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/ui/git-comparison'
OUT.mkdir(parents=True, exist_ok=True)
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1900x1100x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-comparison-visual-') as temporary:
        workspace = Path(temporary)
        env = dict(os.environ, DISPLAY=display, HOME=temporary, TERM='xterm-256color', XI_FORMATTER_COMMAND='/bin/cat')
        def git(*args):
            subprocess.run(['git', *args], cwd=workspace, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        git('init', '-q')
        git('config', 'user.email', 'fixture@example.com')
        git('config', 'user.name', 'Fixture')
        target = workspace / 'example.ts'
        base = [f'const item{n} = {n};\n' for n in range(65)]
        base[30:34] = ['export function greet(name: string) {\n', '  const obsolete = true;\n', '  return "Hello " + name;\n', '}\n']
        target.write_text(''.join(base))
        git('add', 'example.ts')
        git('commit', '-qm', 'baseline')
        changed = base[:30] + ['export function welcome(name: string) {\n', '  return `Hello ${name} 👋`;\n', '}\n'] + base[34:]
        target.write_text(''.join(changed))
        with (OUT / 'xterm.log').open('w') as log:
            terminal = subprocess.Popen(['xterm', '-geometry', '180x38+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '10', '-e', 'bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)], cwd=workspace, env=env, stdout=log, stderr=log)
            try:
                time.sleep(2)
                window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
                def xdo(*args):
                    subprocess.run(['xdotool', *args], env=env, check=True)
                xdo('windowfocus', window)
                xdo('type', '--clearmodifiers', ' vd')
                time.sleep(1.5)
                subprocess.run(['import', '-window', window, str(OUT / 'wide.png')], env=env, check=True)
                xdo('type', '--clearmodifiers', 'iEDIT with spaces []')
                xdo('key', 'Escape')
                time.sleep(.4)
                subprocess.run(['import', '-window', window, str(OUT / 'edited.png')], env=env, check=True)
                xdo('windowsize', window, '645', '540')
                time.sleep(.7)
                subprocess.run(['import', '-window', window, str(OUT / 'narrow.png')], env=env, check=True)
                xdo('type', ':w')
                xdo('key', 'Return')
                expected = ''.join(changed).replace('export function welcome', 'EDIT with spaces []export function welcome', 1)
                deadline = time.monotonic() + 8
                while target.read_text() != expected and time.monotonic() < deadline:
                    time.sleep(.1)
                subprocess.run(['import', '-window', window, str(OUT / 'saved.png')], env=env, check=True)
                assert target.read_text() == expected, f'exact bytes after edit/resize/save: {target.read_text()!r}'
                xdo('key', 'Escape')
                time.sleep(.2)
                xdo('type', ':qa!')
                xdo('key', 'Return')
                terminal.wait(timeout=5)
            finally:
                if terminal.poll() is None:
                    terminal.terminate()
                    terminal.wait(timeout=5)
finally:
    xvfb.terminate()
    xvfb.wait(timeout=5)
print(f'Comparison xterm screenshots and exact edit/save passed: {OUT}')
