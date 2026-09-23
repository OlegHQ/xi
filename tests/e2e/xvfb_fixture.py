"""Start an isolated Xvfb display only after its socket is ready."""
import select
import subprocess


def start_xvfb() -> tuple[subprocess.Popen[bytes], str]:
    process = subprocess.Popen(
        ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x800x24"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if process.stdout is None or not select.select([process.stdout], [], [], 5)[0]:
        process.terminate()
        raise SystemExit("Xvfb did not allocate a display")
    number = process.stdout.readline().decode().strip()
    process.stdout.close()
    if not number.isdigit():
        process.terminate()
        raise SystemExit(f"Xvfb did not start: {number!r}")
    return process, f":{number}"
