#!/usr/bin/env python3
"""Real TypeScript server + production Xi in xterm; screenshots for inline/picker review."""
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/ui/diagnostics'
OUT.mkdir(parents=True, exist_ok=True)
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1600x1000x24'], stdout=subprocess.PIPE, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-diagnostics-visual-') as temporary:
        workspace = Path(temporary)
        (workspace / 'package.json').write_text('{}\n')
        (workspace / 'tsconfig.json').write_text('{"compilerOptions":{"strict":true}}\n')
        target = workspace / 'main.ts'
        target.write_text('export {};\n\nconst x: string = 2;\n\nconsole.log("Diagnostics stay outside the document");\n')
        env = dict(os.environ, DISPLAY=display, HOME=temporary, TERM='xterm-256color')
        with (OUT / 'xterm.log').open('w') as log:
            terminal = subprocess.Popen(['xterm', '-geometry', '140x40+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '11', '-e', 'bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)], cwd=workspace, env=env, stdout=log, stderr=log)
            try:
                time.sleep(8)
                window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
                def xdo(*args): subprocess.run(['xdotool', *args], env=env, check=True)
                def capture(name):
                    time.sleep(.5)
                    subprocess.run(['import', '-window', window, str(OUT / f'{name}.png')], env=env, check=True)
                xdo('windowfocus', window)
                capture('inline')
                xdo('type', ' e')
                capture('problems')
                xdo('key', 'Escape')
                xdo('type', ' d')
                capture('picker')
                xdo('type', '2322')
                capture('filtered')
                xdo('key', 'Return')
                capture('jump')
                xdo('type', ' tdark')
                xdo('key', 'Return')
                capture('inline-dark')
                xdo('type', ' d')
                capture('picker-dark')
                xdo('windowsize', window, '600', '360')
                capture('narrow')
                xdo('key', 'Escape')
                xdo('type', ':q')
                xdo('key', 'Return')
                terminal.wait(timeout=5)
                assert target.read_text() == 'export {};\n\nconst x: string = 2;\n\nconsole.log("Diagnostics stay outside the document");\n'
            finally:
                if terminal.poll() is None: terminal.terminate(); terminal.wait(timeout=5)
finally:
    xvfb.terminate(); xvfb.wait(timeout=5)
print(f'Diagnostics xterm captures: {OUT}')
