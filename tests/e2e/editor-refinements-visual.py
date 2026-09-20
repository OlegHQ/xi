#!/usr/bin/env python3
"""Real CLI regression: full sidebar picker, Akari cursor guides, ghost/v/delete, split strips."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/ui/editor-refinements'
OUT.mkdir(parents=True, exist_ok=True)
THEMES = Path.home() / '.config/xi/themes'
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1600x1000x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-refinements-') as temporary:
        workspace = Path(temporary)
        themes = workspace / '.config/xi/themes'
        themes.mkdir(parents=True)
        for name in ['akari-night', 'akari-dawn']:
            shutil.copyfile(THEMES / f'{name}.toml', themes / f'{name}.toml')
        (workspace / '.xi.toml').write_text('[editor]\ntheme = "akari-night"\n')
        for index in range(50):
            (workspace / f'file-{index:02}.ts').write_text('export const value = 1;\n')
        target = workspace / 'example.txt'
        original = 'one two three\n' + 'export const value = 1;\n' * 35
        target.write_text(original)
        env = dict(os.environ, DISPLAY=display, HOME=temporary, TERM='xterm-256color')
        command = [os.environ['XI_REFINEMENT_BINARY']] if 'XI_REFINEMENT_BINARY' in os.environ else ['bun', 'run', str(ROOT / 'apps/xi/src/main.ts')]
        with (OUT / 'xterm.log').open('w') as log:
            terminal = subprocess.Popen(['xterm', '-geometry', '120x40+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '10', '-e', *command, str(target)], cwd=workspace, env=env, stdout=log, stderr=log)
            try:
                time.sleep(2)
                window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
                def xdo(*args):
                    subprocess.run(['xdotool', *args], env=env, check=True)
                def capture(name):
                    time.sleep(.4)
                    subprocess.run(['import', '-window', window, str(OUT / f'{name}.png')], env=env, check=True)
                xdo('windowfocus', window)
                capture('akari-editor')
                xdo('type', ' t')
                capture('picker-over-sidebar')
                xdo('type', 'akari-dawn')
                capture('picker-light-preview')
                xdo('key', 'Escape')
                xdo('type', 'w')
                capture('ghost')
                xdo('type', 'v')
                capture('visual-adoption')
                xdo('type', 'd:w')
                xdo('key', 'Return')
                time.sleep(.5)
                capture('after-delete')
                assert target.read_text() == original[4:], 'v/d deletes exactly the previous motion range'
                def pixel(name):
                    return subprocess.check_output(['convert', str(OUT / f'{name}.png'), '-format', '%[pixel:p{276,21}]', 'info:'], text=True)
                assert len({pixel(name) for name in ['akari-editor', 'ghost', 'visual-adoption']}) == 3, 'ghost and Visual have distinct visible backgrounds'
                xdo('type', 'u:w')
                xdo('key', 'Return')
                time.sleep(.5)
                assert target.read_text() == original, 'undo restores exact saved bytes'
                xdo('key', 'ctrl+w')
                xdo('type', 's')
                capture('horizontal-split')
                xdo('key', 'ctrl+w')
                xdo('type', 'v')
                capture('nested-split')
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
print(f'Editor refinements passed real CLI delete/save/undo; screenshots: {OUT}')
