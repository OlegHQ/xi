#!/usr/bin/env python3
"""Capture the T063 semantic endpoint matrix in a genuine XTerm window."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / '.artifacts' / 'ui' / 't063-screenshots'


def quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def capture(name: str, geometry: str, color_mode: str, fixture: str, ascii_mode: bool = False) -> dict[str, object]:
    title = f'Xi-T063-{name}'
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    stderr_path = ARTIFACTS / f'{name}.stderr'
    command = (
        f'cd {quote(str(ROOT))} && XI_UI_TEST_MARKERS=1 '
        f'XI_T063_CASE={quote(fixture)} XI_T063_COLOR_MODE={quote(color_mode)} '
        f'XI_T063_ASCII={1 if ascii_mode else 0} bun run spikes/editor/t063-visual.ts '
        f'2>{quote(str(stderr_path))}'
    )
    child = subprocess.Popen(
        ['xterm', '-title', title, '-geometry', geometry, '-fa', 'Noto Mono', '-fs', '12', '-e', 'bash', '-lc', command],
        env=os.environ.copy(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    window_id: str | None = None
    try:
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            result = subprocess.run(['xdotool', 'search', '--name', title], check=False, capture_output=True, text=True)
            ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            if ids:
                window_id = ids[-1]
                break
            time.sleep(0.05)
        if window_id is None:
            raise RuntimeError(f'xterm window did not appear: {title}')
        time.sleep(1.0)
        image_path = ARTIFACTS / f'{name}.png'
        subprocess.run(['import', '-window', window_id, str(image_path)], check=True)
        return {'name': name, 'geometry': geometry, 'fixture': fixture, 'colorMode': color_mode, 'ascii': ascii_mode, 'window': window_id, 'path': str(image_path)}
    finally:
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=3)


def main() -> None:
    captures = [
        capture('visual-character-120x40', '120x40', 'truecolor', 'visual-character'),
        capture('visual-line-120x40', '120x40', 'truecolor', 'visual-line'),
        capture('visual-block-120x40', '120x40', 'truecolor', 'visual-block'),
        capture('empty-line-80x24', '80x24', 'truecolor', 'empty-line'),
        capture('eof-80x24', '80x24', 'truecolor', 'eof'),
        capture('normal-no-color-60x18', '60x18', 'no-color', 'normal', True),
    ]
    result = {'captures': captures, 'xterm': subprocess.check_output(['xterm', '-version'], text=True, stderr=subprocess.STDOUT).strip()}
    (ARTIFACTS / 'index.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(f'T063 real-terminal visual matrix captured {len(captures)} states')


if __name__ == '__main__':
    main()
