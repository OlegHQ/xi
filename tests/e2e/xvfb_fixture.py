"""Start an isolated Xvfb display only after its socket is ready."""
import select
import subprocess
import time
from pathlib import Path


def start_xvfb() -> tuple[subprocess.Popen[bytes], str]:
    for _ in range(3):
        process = subprocess.Popen(
            ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x800x24"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if process.stdout is not None and select.select([process.stdout], [], [], 5)[0]:
            number = process.stdout.readline().decode().strip()
            process.stdout.close()
            if number.isdigit():
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and process.poll() is None:
                    if Path(f"/tmp/.X11-unix/X{number}").exists():
                        return process, f":{number}"
                    time.sleep(0.05)
        if process.poll() is None:
            process.terminate()
        process.wait()
    raise SystemExit("Xvfb did not allocate a ready display")
