#!/usr/bin/env python3
"""Inspect actual CLI Files/Search/Git sidebar colors using unmodified Helix themes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
THEME = os.environ.get('XI_AUDIT_THEME', 'catppuccin_latte')
OUT = ROOT / '.artifacts/ui' / ('sidebar-' + THEME.removeprefix('catppuccin_'))
OUT.mkdir(parents=True, exist_ok=True)
THEMES = Path(os.environ.get('XI_AUDIT_THEMES', str(Path.home() / '.config/xi/themes')))
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1600x1000x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-latte-visual-') as temporary:
        workspace = Path(temporary)
        themes = workspace / '.config/xi/themes'
        themes.mkdir(parents=True)
        for name in ['catppuccin_latte', 'catppuccin_mocha']:
            shutil.copyfile(THEMES / f'{name}.toml', themes / f'{name}.toml')
        (themes.parent / 'state.json').write_text(json.dumps({'theme': THEME}))
        target = workspace / 'example.ts'
        target.write_text('export const message = "Sidebar contrast";\n')
        def git(*args):
            subprocess.run(['git', *args], cwd=workspace, check=True, stdout=subprocess.DEVNULL)
        git('init', '-q')
        git('add', 'example.ts')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
        target.write_text('export const message = "Sidebar contrast edited";\n')
        env = dict(os.environ, DISPLAY=display, HOME=temporary, TERM='xterm-256color')
        terminal = subprocess.Popen(['xterm', '-geometry', '120x40+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '10', '-e', 'bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)], cwd=workspace, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(2)
            window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
            def xdo(*args):
                subprocess.run(['xdotool', *args], env=env, check=True)
            def capture(name):
                time.sleep(.6)
                subprocess.run(['import', '-window', window, str(OUT / f'{name}.png')], env=env, check=True)
            xdo('windowfocus', window)
            xdo('type', ' vf')
            capture('files')
            xdo('type', ' t')
            capture('picker')
            xdo('key', 'Escape')
            xdo('type', ' vs')
            xdo('type', 'Sidebar')
            capture('search')
            xdo('key', 'Escape')
            xdo('mousemove', '--window', window, '184', '10')
            xdo('click', '1')
            capture('git')
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
print(f'Latte sidebar xterm captures: {OUT}')
