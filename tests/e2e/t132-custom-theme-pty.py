#!/usr/bin/env python3
"""T132: custom theme.toml discovery, selection and invalid-file rejection through the
production CLI.
docs/plan/05-validation.md's E16 row: "Theme preview/cancel..." -> "Token consistency...";
T132's own acceptance also requires "an invalid or missing theme.toml is rejected with a clear
message and never partially applies".

Before this pass, packages/services/config's real parseThemeConfig/ThemeConfig (which can
already parse a theme.toml's tokens) had zero runtime caller -- only the two built-in themes
(xi-light, xi-dark) existed. This exercises the real, new wiring: apps/xi/src/main.ts's
discoverCustomThemes reads every *.toml under ~/.config/xi/themes/ at startup, using the real
parser and a new workbenchThemeFromTokens validator that requires every core WorkbenchTheme
field explicitly (background/surface/surface.active/foreground/muted/border/accent/error, using
the dotted-lowercase naming DEFAULT_THEME_TOML and tests/config/t036-config.test.ts already
established for the optional editor-layer tokens, extended consistently for the required base
ones that example never covered) -- never partially applying a theme missing any of them.

This fixture: seeds ~/.config/xi/themes/ with one genuinely valid custom theme.toml ("Neon")
and one invalid one (missing its [tokens] table entirely). Confirms the invalid file never
blocks startup and is rejected with a clear stderr message naming the file; confirms the valid
custom theme appears in the theme picker and previews live with its own real color (checked
via the actual terminal SGR bytes, not a mocked assertion) -- proving it is genuinely usable
end to end, not just parsed and discarded.
"""
from __future__ import annotations

import os
import pty
import re
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Neon's background token (#000011 -> 0;0;17) as a real terminal truecolor SGR background
# escape -- an unambiguous signal that this specific custom theme, and only it, is painting.
NEON_BACKGROUND = b"\x1b[48;2;0;0;17m"
LIGHT_BACKGROUND = b"\x1b[48;2;252;252;250m"


def read_for(master: int, captured: bytearray, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            continue
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            return


def wait_for(master: int, captured: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in captured and time.monotonic() < deadline:
        read_for(master, captured, 0.05)
    if marker not in captured:
        raise SystemExit(f"missing PTY marker {marker!r}: {captured[-4000:]!r}")


with tempfile.TemporaryDirectory(prefix="xi-t132-custom-theme-") as temporary:
    home = Path(temporary)
    themes_directory = home / ".config" / "xi" / "themes"
    themes_directory.mkdir(parents=True)
    (home / "a.txt").write_text("hi\n", encoding="utf-8")
    (themes_directory / "neon.toml").write_text(
        'schema-version = 1\nname = "Neon"\n\n[tokens]\n'
        'background = "#000011"\nsurface = "#000022"\n"surface.active" = "#000033"\n'
        'foreground = "#00FF00"\nmuted = "#008800"\nborder = "#004400"\n'
        'accent = "#00FFFF"\nerror = "#FF0000"\n',
        encoding="utf-8",
    )
    # Invalid: no [tokens] table at all -- parseThemeConfig itself must reject this, not crash.
    (themes_directory / "broken.toml").write_text('schema-version = 1\nname = "Broken"\n', encoding="utf-8")
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(home), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "a.txt"],
        cwd=home,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    try:
        wait_for(master, captured, b"XI_WORKBENCH_READY", 10)
        read_for(master, captured, 0.4)
        if child.poll() is not None:
            raise SystemExit(f"an invalid custom theme.toml crashed startup: {captured[-4000:]!r}")

        # The invalid theme file must be rejected with a clear, specific message.
        rejection = re.search(rb"xi: theme file broken\.toml is invalid: [^\r\n]*", captured)
        if rejection is None:
            raise SystemExit(f"the invalid custom theme was not rejected with a clear message: {captured[-4000:]!r}")

        # The valid custom theme must be discoverable and genuinely selectable/previewable.
        os.write(master, b" t")
        read_for(master, captured, 0.4)
        before_filter = len(captured)
        os.write(master, b"neon")
        read_for(master, captured, 0.4)
        if NEON_BACKGROUND not in captured[before_filter:]:
            raise SystemExit(f"the valid custom theme did not preview live: {captured[before_filter:][-4000:]!r}")
        os.write(master, b"\r")
        wait_for(master, captured, b"XI_THEME_APPLIED", 5)
        read_for(master, captured, 0.3)

        os.write(master, b":q\r")
        for _ in range(5):
            if child.poll() is not None:
                break
            read_for(master, captured, 0.3)
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

    if child.returncode != 0:
        raise SystemExit(f"custom theme session exited {child.returncode}")

    # Explicit failure case from T132's own ticket: "Theme file removed from disk after being
    # selected." Committing Neon above also persisted it to ~/.config/xi/state.json; removing
    # its source file and relaunching must fall back gracefully (light theme), never crash and
    # never show stale/partial Neon colors.
    (themes_directory / "neon.toml").unlink()
    master3, slave3 = pty.openpty()
    child3 = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "a.txt"],
        cwd=home,
        env=environment,
        stdin=slave3,
        stdout=slave3,
        stderr=slave3,
        close_fds=True,
    )
    os.close(slave3)
    captured3 = bytearray()
    try:
        wait_for(master3, captured3, b"XI_WORKBENCH_READY", 10)
        read_for(master3, captured3, 0.4)
        if child3.poll() is not None:
            raise SystemExit(f"relaunching after the selected custom theme's file was removed crashed: {captured3[-4000:]!r}")
        if NEON_BACKGROUND in captured3:
            raise SystemExit(f"a removed custom theme's colors still appeared after relaunch: {captured3[-4000:]!r}")
        if LIGHT_BACKGROUND not in captured3:
            raise SystemExit(f"did not fall back to the light theme after the selected custom theme's file was removed: {captured3[-4000:]!r}")
        os.write(master3, b":q\r")
        for _ in range(5):
            if child3.poll() is not None:
                break
            read_for(master3, captured3, 0.3)
        child3.wait(timeout=5)
    finally:
        if child3.poll() is None:
            child3.kill()
            child3.wait()
        os.close(master3)
    if child3.returncode != 0:
        raise SystemExit(f"the relaunched session exited {child3.returncode}")

print("T132-CUSTOM-THEME-PTY pass: an invalid custom theme.toml never blocked startup and was "
      "rejected with a clear, specific message, a genuinely valid one alongside it was "
      "discovered, listed in the theme picker, and previewed live with its own real color, and "
      "removing a committed custom theme's file before the next launch fell back gracefully to "
      "the light theme with no crash -- all through the production CLI")
