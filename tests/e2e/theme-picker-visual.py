#!/usr/bin/env python3
"""Theme picker in real xterm: current theme, paging, hover, resize and cancel."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/ui/theme-picker'
OUT.mkdir(parents=True, exist_ok=True)
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1600x1000x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-theme-visual-') as temporary:
        workspace = Path(temporary)
        themes = workspace / '.config/xi/themes'
        themes.mkdir(parents=True)
        for index in range(60):
            background, foreground = ('#fcfcfa', '#1e2430') if index % 2 == 0 else ('#1e1e2e', '#cdd6f4')
            (themes / f'fixture-{index:02}.toml').write_text(
                f'"ui.background" = {{ bg = "{background}" }}\n'
                f'"ui.text" = "{foreground}"\n'
                f'"ui.menu" = {{ bg = "{background}", fg = "{foreground}" }}\n'
                '"ui.menu.scroll" = { fg = "#245a88" }\n'
                '"ui.window" = "#245a88"\n'
                '"ui.menu.selected" = { bg = "#245a88", fg = "#ffffff" }\n')
        (themes.parent / 'state.json').write_text(json.dumps({'theme': 'fixture-50'}))
        target = workspace / 'example.ts'
        for index in range(60):
            (workspace / f'file-{index:02}.ts').write_text('export const value = 1;\n')
        target.write_text('export const message = "Live theme preview";\n')
        env = dict(os.environ, DISPLAY=display, HOME=temporary, TERM='xterm-256color')
        with (OUT / 'xterm.log').open('w') as log:
            terminal = subprocess.Popen(['xterm', '-geometry', '120x40+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '10', '-e', 'bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)], cwd=workspace, env=env, stdout=log, stderr=log)
            try:
                time.sleep(2)
                window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
                def xdo(*args):
                    subprocess.run(['xdotool', *args], env=env, check=True)
                def capture(name):
                    time.sleep(.4)
                    subprocess.run(['import', '-window', window, str(OUT / f'{name}.png')], env=env, check=True)
                xdo('windowfocus', window)
                xdo('type', ' t')
                capture('current-theme')
                xdo('key', 'ctrl+u')
                capture('half-page-up')
                xdo('key', 'ctrl+d', 'ctrl+n')
                capture('dark-preview')
                xdo('windowsize', window, '484', '292')
                capture('narrow')
                xdo('key', 'Escape')
                capture('cancel')
                assert json.loads((themes.parent / 'state.json').read_text())['theme'] == 'fixture-50'
                assert target.read_text() == 'export const message = "Live theme preview";\n'
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
print(f'Theme picker xterm captures: {OUT}')
