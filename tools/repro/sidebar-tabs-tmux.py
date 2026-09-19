#!/usr/bin/env python3
import os, pty, select, subprocess, sys, tempfile, time, fcntl, termios, struct
from pathlib import Path
ROOT = Path('/home/snowbear/projects/xi')
XI = sys.argv[1] if len(sys.argv) > 1 else f"bun run {ROOT}/apps/xi/src/main.ts"
SOCK = f"xirepro{os.getpid()}"
def sh(*a): return subprocess.run(["tmux", "-L", SOCK, *a], capture_output=True, text=True)
def cap(): return sh("capture-pane", "-p", "-t", "0").stdout
def wr(master, b):
    os.write(master, b)
def drain(master, t):
    end = time.monotonic() + t
    while time.monotonic() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: os.read(master, 65536)
            except OSError: return
def mouse(m, b, x, y, rel=False): wr(m, f"\x1b[<{b};{x};{y}{'m' if rel else 'M'}".encode())
def click(m, x, y): mouse(m, 0, x, y); drain(m, 0.05); mouse(m, 0, x, y, True); drain(m, 0.4)
def show(tag, rows=14):
    print(f"===== {tag}"); print("\n".join(cap().splitlines()[:rows]))
with tempfile.TemporaryDirectory(prefix="xi-repro-") as tmp:
    ws = Path(tmp) / "ws"; (ws / "src").mkdir(parents=True)
    (ws / "src" / "animals.txt").write_text("dog\ncat\nbird\n")
    (ws / "src" / "other.txt").write_text("nothing\n")
    (ws / "README.md").write_text("hello\n")
    subprocess.run(["git", "init", "-q"], cwd=ws); subprocess.run(["git", "add", "."], cwd=ws)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], cwd=ws)
    (ws / "README.md").write_text("hello changed\n"); (ws / "new.txt").write_text("new\n")
    markers = Path(tmp) / "markers.log"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", HOME=tmp, XI_UI_TEST_MARKERS="1")
    child = subprocess.Popen(["tmux", "-L", SOCK, "-f", "/dev/null", "new-session", "-x", "120", "-y", "40", "-c", str(ws), f"cd {ws} && {XI} 2>{markers}"], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    drain(master, 1.0); sh("set", "-g", "mouse", "on"); drain(master, 2.5)
    try:
        show("startup")
        click(master, 14, 1); wr(master, b"cat"); drain(master, 1.0); wr(master, b"\r"); drain(master, 0.8); show("search cat + Enter")
        click(master, 5, 1); drain(master, 0.8); show("clicked Files after opening match")
        click(master, 14, 1); drain(master, 0.6); show("clicked Search again")
        click(master, 5, 1); drain(master, 0.6); show("clicked Files after search")
        click(master, 23, 1); drain(master, 1.2); show("clicked Git", 20)
        click(master, 5, 1); drain(master, 0.6); show("clicked Files after git")
        click(master, 23, 1); drain(master, 1.0); click(master, 14, 1); drain(master, 0.6); show("git then search")
        wr(master, b"\x1b:q!\r"); drain(master, 0.5)
    finally:
        sh("kill-server"); child.wait(timeout=5)
        print("===== markers"); print("\n".join(l for l in markers.read_text(errors="replace").splitlines() if "XI_" in l)[-3000:])
