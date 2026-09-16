#!/usr/bin/env python3
"""Regression checks for the production PTY readiness matcher."""

import runpy
from pathlib import Path


namespace = runpy.run_path(str(Path(__file__).with_name("pty-ui.py")))
contains_visible_marker = namespace["contains_visible_marker"]
visible_utf8 = namespace["visible_utf8"]

# Styling and cursor motion may split visible text in the raw PTY stream.
styled = b"a\x1b[31m  \x1b[1C\xf0\x9f\x98\x80"
assert contains_visible_marker(styled, "a😀")

# Never match a marker using only a partial UTF-8 prefix of the supplementary scalar.
assert visible_utf8(b"a\xf0\x9f") is None
assert not contains_visible_marker(b"a\xf0\x9f", "a😀")
assert contains_visible_marker(b"a\xf0\x9f\x98\x80", "a😀")

print("PASS T099-PTY-CSI-SGR-UTF8-01")
print("PASS T099-PTY-INCOMPLETE-UTF8-REJECT-01")
