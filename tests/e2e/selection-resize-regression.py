#!/usr/bin/env python3
"""Actual Xi CLI: line-boundary ghost, Visual half-page edit, mode recovery and split drag."""
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.artifacts/selection-fixes'
OUT.mkdir(parents=True, exist_ok=True)
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1700x1100x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    display = ':' + xvfb.stdout.readline().strip()
    with tempfile.TemporaryDirectory(prefix='xi-selection-resize-') as tmp:
        workspace = Path(tmp)
        (workspace / '.xi.toml').write_text('[editor]\nsidebar-visible = false\n')
        target = workspace / 'source.txt'
        lines = ['one two\n'] + [f'row{i:03} ' + 'long source content ' * 20 + '\n' for i in range(99)]
        original = ''.join(lines)
        target.write_text(original)
        env = dict(os.environ, DISPLAY=display, HOME=tmp, TERM='xterm-256color')
        with (OUT / 'xi-xterm.log').open('w') as log:
            terminal = subprocess.Popen(['xterm', '-geometry', '120x40+0+0', '-fa', 'DejaVu Sans Mono', '-fs', '10', '-e', 'bun', 'run', str(ROOT / 'apps/xi/src/main.ts'), str(target)], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                time.sleep(1.5)
                window = subprocess.check_output(['xdotool', 'search', '--class', 'xterm'], env=env, text=True).splitlines()[-1]
                def xdo(*args): subprocess.run(['xdotool', *args], env=env, check=True)
                def type_keys(text): xdo('type', '--clearmodifiers', '--delay', '15', text)
                def key(*keys): xdo('key', '--clearmodifiers', *keys)
                def capture(name):
                    time.sleep(.25)
                    subprocess.run(['import', '-window', window, str(OUT / f'{name}.png')], env=env, check=True)
                def save():
                    type_keys(':w'); key('Return'); time.sleep(.25)
                def undo():
                    type_keys('u'); save(); assert target.read_text() == original
                xdo('windowfocus', window)
                type_keys('ww'); capture('word-at-eol')
                type_keys('vd'); save()
                assert target.read_text() == 'one \n' + ''.join(lines[1:]), 'ghost excludes newline and next-line character'
                undo()
                type_keys('gg0V'); key('ctrl+d'); capture('visual-line-half-page')
                type_keys('d'); save()
                assert target.read_text() == ''.join(lines[25:]), '39-row viewport and scrolloff=5: half-page extends through row023 (Neovim oracle line 25)'
                undo()
                type_keys('gg020jV'); key('ctrl+u'); type_keys('d'); save()
                assert target.read_text() == lines[0] + ''.join(lines[21:]), 'Ctrl-U extends backward across 20 selected lines'
                undo()
                type_keys('gg0'); key('ctrl+v'); type_keys('iw'); key('Escape');
                type_keys('gg0i'); key('ctrl+v'); type_keys('u'); key('Up'); type_keys('Z'); key('Escape'); save()
                assert target.read_text().startswith('<Up>Zone two\n'), 'literal-prompt recovery continues editing'
                undo()
                type_keys('gg0'); key('ctrl+w'); type_keys('v'); capture('split-before-drag')
                dimensions = subprocess.check_output(['identify', '-format', '%w %h', str(OUT / 'split-before-drag.png')], text=True).split()
                cell_width = (int(dimensions[0]) - 4) / 120
                cell_height = (int(dimensions[1]) - 4) / 40
                def mouse(column, row): xdo('mousemove', '--window', window, str(round(2 + (column + .5) * cell_width)), str(round(2 + (row + .5) * cell_height)))
                mouse(59, 10); xdo('mousedown', '1'); mouse(39, 10); time.sleep(.1); xdo('mouseup', '1')
                capture('split-after-drag')
                key('ctrl+w'); type_keys('s'); capture('nested-after-drag')
                # The lower pane's populated buffer strip is also the horizontal split
                # handle: a drag over its tab text resizes instead of activating the tab.
                mouse(42, 19); xdo('mousedown', '1'); mouse(42, 22); time.sleep(.1); mouse(42, 25); xdo('mouseup', '1')
                capture('nested-after-tab-drag')
                xdo('windowsize', window, '1100', '820'); capture('terminal-resized')
                type_keys(':qa!'); key('Return'); terminal.wait(timeout=5)
            finally:
                if terminal.poll() is None: terminal.terminate(); terminal.wait(timeout=5)
finally:
    xvfb.terminate(); xvfb.wait(timeout=5)
print(f'Xi real CLI ghost, Ctrl-U/D selection edits, recovery and resize captures passed: {OUT}')
