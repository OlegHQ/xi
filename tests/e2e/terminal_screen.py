"""Small VT text grid for PTYs that need final cells instead of paint-run coordinates."""
from __future__ import annotations

import re

CSI = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])")
OSC = re.compile(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")


class Screen:
    def __init__(self, rows: int, cols: int) -> None:
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0

    def feed(self, data: bytes) -> None:
        text = data.decode("utf-8", errors="replace")
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\x1b":
                match = CSI.match(text, index)
                if match:
                    if match.group(2) in ("H", "f"):
                        parts = [int(value) for value in match.group(1).split(";") if value.isdigit()]
                        self.row = max(0, (parts[0] if parts else 1) - 1)
                        self.col = max(0, (parts[1] if len(parts) > 1 else 1) - 1)
                    index = match.end()
                    continue
                match = OSC.match(text, index)
                if match:
                    index = match.end()
                    continue
                index += 2
                continue
            if char == "\r":
                self.col = 0
            elif char == "\n":
                self.row = min(self.rows - 1, self.row + 1)
            elif char >= " " and char != "\x7f":
                if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
                    self.grid[self.row][self.col] = char
                self.col += 1
            index += 1

    def row_text(self, row: int) -> str:
        return "".join(self.grid[row - 1])
