#!/usr/bin/env python3
"""Cold first-input bursts through the production source and bytecode CLI."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("startup", ROOT / "tests/support/startup-pty.py")
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)
binary = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "dist/xi").resolve()
assert binary.is_file(), "Build the shipping executable with bun run package:build first"
output = ROOT / ".artifacts/e2e/t122-startup-input"
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="xi-first-input-") as directory:
    for name, command in (
        ("source", [shutil.which("bun"), "run", "apps/xi/src/main.ts"]),
        ("bytecode", [str(binary)]),
    ):
        for index, payload in enumerate(("café 漢字 🙂 e\u0301 ", "abcdefghijklmnopqrstuvwxyz" * 8)):
            # No sleep after readiness: input arrives as optional initialization
            # used to begin. trial verifies exact saved bytes, mode and exit.
            startup.trial(name, command, Path(directory), output, index, edit=payload.encode())
print("T122 source/bytecode first Unicode and 208-character bursts saved exact bytes")
