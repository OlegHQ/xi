#!/usr/bin/env python3
"""Compiled CLI feasibility comparison. Parsed VT correctness; never a physical gate.

Install ui-proof-requirements.txt in an isolated environment. Inputs follow absolute
deadlines independently of responses. Every event retains injection slippage and
completes only when its cumulative text/cursor state is observed by the VT parser.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import pty
import random
import re
import select
import subprocess
import sys
import tempfile
import termios
import time
import struct

import pyte
from wcwidth import wcswidth

ROOT = Path(__file__).resolve().parents[2]
ROW = re.compile(r"(?P<prefix>[aé漢]*)ROW(?P<number>\d{5})")


class Screen(pyte.Screen):
    """Observe only complete synchronized frames (or a complete non-sync read)."""
    def __init__(self, columns, lines, oracle=False):
        self.oracle = oracle
        self.synchronized = False
        self.on_frame = lambda: None
        super().__init__(columns, lines)

    def set_mode(self, *modes, **kwargs):
        super().set_mode(*modes, **kwargs)
        if kwargs.get('private') and 2026 in modes:
            self.synchronized = True

    def reset_mode(self, *modes, **kwargs):
        super().reset_mode(*modes, **kwargs)
        if kwargs.get('private') and 2026 in modes:
            self.synchronized = False
            self.on_frame()

    def row_text(self, y):
        # pyte may retain an empty wide-cell continuation after cursor/erase updates.
        # Skip occupied continuation cells; an orphan continuation is a blank cell.
        cells = self.buffer[y]; parts = []; x = 0
        while x < self.columns:
            data = cells[x].data or ' '
            parts.append(data)
            x += max(1, wcswidth(data))
        return ''.join(parts)

    @property
    def display(self):
        return [self.row_text(y) for y in range(self.lines)]

    def editor_state(self):
        # Xi paints its cursor into cells; the terminal's hardware cursor is hidden.
        # This fixture uses Xi Light's pinned block color and Insert's underline.
        if self.oracle:
            if self.cursor.hidden:
                return None
            row = self.row_text(self.cursor.y)
            match = ROW.search(row)
            if match is None or wcswidth(row[:match.start('number') - 3]) != self.cursor.x:
                return None
            mode = 'insert' if '-- INSERT --' in self.row_text(self.lines - 1) else 'normal'
            return (int(match['number']), match['prefix'], mode)
        candidates = []
        for y, cells in self.buffer.items():
            for column, cell in cells.items():
                if cell.data != 'R' or not (cell.bg == '14202e' or cell.underscore):
                    continue
                row = self.row_text(y)
                match = ROW.search(row)
                if match is not None and wcswidth(row[:match.start('number') - 3]) == column:
                    candidates.append((int(match['number']), match['prefix'], 'insert' if cell.underscore else 'normal'))
        return candidates[0] if len(candidates) == 1 else None


def percentiles(values):
    ordered = sorted(values)
    return {name: ordered[max(0, math.ceil(len(ordered) * p) - 1)] for name, p in [('p50', .5), ('p95', .95), ('p99', .99), ('max', 1)]} if ordered else None


def schedule():
    events = []
    due = 0.05
    line = 0
    # Different action families remain distinguishable in the raw report.
    for family, count, interval in [('paced-j', 20, .05), ('held-down', 30, 1 / 60), ('burst-j', 30, .001)]:
        for _ in range(count):
            line += 1
            events.append(dict(due=due, family=family, key='j' if family != 'held-down' else '\x1b[B', expected=[line, '', 'normal']))
            due += interval
        due += .1
    return events, line


def trial(binary: Path, load: bool, output: Path, width: int, scenario: str, oracle=False):
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='xi-ui-proof-') as temporary:
        workspace = Path(temporary)
        home = workspace / 'home'; home.mkdir()
        source = '\n'.join(f'ROW{i:05d} alpha beta gamma' for i in range(400)) + '\n'
        target = workspace / 'proof.txt'; target.write_text(source)
        if load:
            (workspace / '.xi').mkdir()
            task = "import os,time\nfor i in range(20000):\n os.write(1, b'load ' * 400 + b'\\n')\n open('heartbeat.next','w').write(str(i))\n os.replace('heartbeat.next','heartbeat')\n time.sleep(.003)\n"
            (workspace / 'flood.py').write_text(task)
            (workspace / '.xi/tasks.toml').write_text('schema-version = 1\n[[task]]\nid = "flood"\nargv = '+json.dumps([sys.executable, 'flood.py'])+'\n')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, width, 0, 0))
        screen = Screen(width, 40, oracle); stream = pyte.ByteStream(screen)
        transcript = bytearray(); errors = bytearray()
        # Prepare the independent input process before timing application startup.
        producer = """import json,os,sys,time
fd=int(sys.argv[1]); print('ready',flush=True)
for line in sys.stdin:
 events=json.loads(line)
 for event in events:
  time.sleep(max(0,event['scheduled']-time.perf_counter()))
  event['written']=time.perf_counter()
  data=event['key'].encode()
  assert os.write(fd,data)==len(data)
 print(json.dumps([event['written'] for event in events]),flush=True)
"""
        injector = subprocess.Popen([sys.executable, '-u', '-c', producer, str(master)],
            pass_fds=(master,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert injector.stdout.readline() == b'ready\n'
        started = time.perf_counter()
        argv = [str(binary), str(target)] if not oracle else [str(binary), '--clean', '-i', 'NONE', '-n', '-c', 'set nowrap noshowcmd noruler laststatus=0', str(target)]
        child = subprocess.Popen(argv, cwd=workspace,
            env=dict(os.environ, HOME=str(home), TERM='xterm-256color', XI_UI_TEST_MARKERS='1'),
            stdin=slave, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        assert child.stderr is not None
        events = []
        completed = 0
        feeder_errors = []
        captured = None
        observed_at = None

        def observe():
            nonlocal completed
            state = screen.editor_state()
            if state is None:
                return
            # Later cumulative output completes earlier events at that same timestamp.
            now = observed_at if observed_at is not None else time.perf_counter()
            matches = [i for i in range(completed, len(events)) if events[i].get('written', float('inf')) <= now and events[i]['expected'] == list(state)]
            if matches:
                for event in events[completed:matches[-1] + 1]:
                    event['completed'] = now
                completed = matches[-1] + 1

        screen.on_frame = observe

        def pump(timeout=.02):
            for fd in select.select([master, child.stderr.fileno()], [], [], timeout)[0]:
                try: chunk = os.read(fd, 65536)
                except OSError: continue
                if fd != master:
                    errors.extend(chunk)
                    continue
                received = time.perf_counter()
                transcript.extend(chunk)
                if captured is not None:
                    captured.append((received, chunk))
                    continue
                stream.feed(chunk)
                if not screen.synchronized:
                    observe()

        def until(predicate, seconds=10):
            deadline = time.perf_counter() + seconds
            while not predicate():
                if child.poll() is not None or time.perf_counter() > deadline:
                    raise AssertionError(f'timeout/exit waiting for correct state: {screen.editor_state()}\n'+'\n'.join(screen.display))
                pump()

        def settle(seconds=.1):
            deadline = time.perf_counter() + seconds
            while time.perf_counter() < deadline: pump(.01)

        def run_events(batch):
            nonlocal events, completed, captured, observed_at
            events = batch; completed = 0
            origin = time.perf_counter()
            for event in events:
                event['scheduled'] = origin + event['due']
            captured = []
            try:
                injector.stdin.write((json.dumps(events) + '\n').encode()); injector.stdin.flush()
                deadline = origin + events[-1]['due'] + .25
                while not select.select([injector.stdout], [], [], 0)[0] or time.perf_counter() < deadline:
                    if injector.poll() is not None or time.perf_counter() > deadline + 5:
                        raise AssertionError('input producer did not finish')
                    pump(.002)
                written = json.loads(injector.stdout.readline())
                assert len(written) == len(events)
                for event, timestamp in zip(events, written):
                    event['written'] = timestamp
                chunks = captured; captured = None
                for observed_at, chunk in chunks:
                    stream.feed(chunk)
                    if not screen.synchronized: observe()
                observed_at = None
                until(lambda: completed == len(events), seconds=5)
            finally:
                captured = None; observed_at = None
            assert completed == len(events)
            for event in events:
                event['schedule_to_correct_ms'] = (event['completed'] - event['scheduled']) * 1000
                event['write_to_correct_ms'] = (event['completed'] - event['written']) * 1000
                event['injection_slippage_ms'] = (event['written'] - event['scheduled']) * 1000
            return events

        try:
            until(lambda: screen.editor_state() == (0, '', 'normal'))
            startup_ms = (time.perf_counter() - started) * 1000
            # Check the first key without an arbitrary post-startup warm-up pause.
            first = run_events([dict(due=0, family='first-key', key='j', expected=[1, '', 'normal'])])
            if scenario == 'startup':
                process_status = Path(f'/proc/{child.pid}/status').read_text()
                os.write(master, b':q\r')
                deadline = time.perf_counter() + 10
                while child.poll() is None and time.perf_counter() < deadline: pump()
                assert child.wait(timeout=1) == 0
                assert target.read_bytes() == source.encode(), 'startup journey changed file bytes'
                return dict(startup_ms=startup_ms, correct=True, events=first,
                    groups={'first-key': {key: percentiles([event[key] for event in first]) for key in ['schedule_to_correct_ms', 'write_to_correct_ms', 'injection_slippage_ms']}},
                    process_memory={key: re.search(rf'^{key}:\s+(\d+) kB', process_status, re.M)[1] for key in ['VmRSS', 'VmHWM']})
            os.write(master, b'gg'); until(lambda: screen.editor_state() == (0, '', 'normal'))
            if load:
                os.write(master, b':task flood\r')
                until(lambda: b'XI_TASK_STARTED' in errors and (workspace / 'heartbeat').exists())
                os.write(master, b'\x1b')
                until(lambda: b'XI_OUTPUT_CLOSED' in errors and screen.editor_state() == (0, '', 'normal'))
                heartbeat_before = int((workspace / 'heartbeat').read_text())
            motions, line = schedule()
            if scenario == "surface":
                motions = motions[:5]; line = 5
            motion_results = run_events(motions)
            os.write(master, b'i'); until(lambda: screen.editor_state() == (line, '', 'insert')); settle(.02)
            payload = ''; inserts = []; due = .05
            for i in range(6 if scenario == "surface" else 40):
                char = 'aé漢'[i % 3]; payload += char
                inserts.append(dict(due=due, family='paced-insert' if i < 20 else 'burst-insert', key=char, expected=[line, payload, 'insert']))
                due += .05 if i < 20 else .001
            insertion_results = run_events(inserts)
            if load:
                heartbeat_after = int((workspace / 'heartbeat').read_text())
                assert heartbeat_after > heartbeat_before, 'task must stay active throughout measured editing'
                assert b'XI_TASK_EXITED' not in errors, 'load exited before completion'
            else: heartbeat_before = heartbeat_after = None
            os.write(master, b'\x1b'); settle(.04)
            os.write(master, b'l'); until(lambda: screen.editor_state() == (line, payload, 'normal'))
            status_text = None
            if not oracle:
                # Exercise the replacement surface, command-line hiding and dismissal.
                os.write(master, b':task missing\r'); until(lambda: "unknown task 'missing'" in screen.display[-1])
                status_text = screen.display[-1]
                os.write(master, b':'); until(lambda: screen.display[-1].lstrip().startswith(':'))
                assert 'unknown task' not in screen.display[-1]
                os.write(master, b'\x1b'); until(lambda: screen.editor_state() == (line, payload, 'normal'))
            process_status = Path(f'/proc/{child.pid}/status').read_text()
            if load:
                os.write(master, b':taskstop\r'); settle(.1)
            os.write(master, b':wq\r')
            deadline = time.perf_counter() + 10
            while child.poll() is None and time.perf_counter() < deadline: pump()
            assert child.wait(timeout=1) == 0
            expected = source.splitlines(keepends=True); expected[line] = payload + expected[line]
            assert target.read_bytes() == ''.join(expected).encode(), 'exact final file differs'
            all_events = first + motion_results + insertion_results
            groups = {}
            for family in dict.fromkeys(event['family'] for event in all_events):
                selected = [event for event in all_events if event['family'] == family]
                groups[family] = {key: percentiles([event[key] for event in selected]) for key in ['schedule_to_correct_ms', 'write_to_correct_ms', 'injection_slippage_ms']}
            return dict(startup_ms=startup_ms, groups=groups, events=all_events, correct=True,
                status_text=status_text, task_heartbeat=[heartbeat_before, heartbeat_after],
                process_memory={key: re.search(rf'^{key}:\s+(\d+) kB', process_status, re.M)[1] for key in ['VmRSS', 'VmHWM']})
        finally:
            if child.poll() is None: child.kill(); child.wait()
            injector.stdin.close()
            try: injector.wait(timeout=1)
            except subprocess.TimeoutExpired: injector.kill(); injector.wait()
            feeder_errors.extend(injector.stderr.read().decode(errors='replace').splitlines())
            injector.stdout.close(); injector.stderr.close()
            os.close(master); child.stderr.close()
            (output / 'terminal.ansi').write_bytes(transcript)
            (output / 'stderr.txt').write_bytes(errors)
            (output / 'screen.txt').write_text('\n'.join(screen.display))
            (output / 'last-events.json').write_text(json.dumps(dict(completed=completed, events=events, feeder_errors=feeder_errors), indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--neovim', type=Path, help='optional pinned clean oracle; idle comparison only')
    parser.add_argument('--binary', action='append', required=True, help='name=/absolute/binary')
    parser.add_argument('--scenario', choices=['full', 'surface', 'startup'], default='full', help='surface is a limited integration check; startup checks usable cells, first key and clean exit only')
    parser.add_argument('--sessions', type=int, default=12)
    parser.add_argument('--width', type=int, default=120)
    parser.add_argument('--load', choices=['idle', 'task', 'both'], default='both')
    args = parser.parse_args()
    assert args.sessions > 0 and args.width >= 120
    assert args.scenario != 'startup' or args.load == 'idle', 'startup-only comparisons require --load idle'
    assert not args.output.exists(), 'retain old results; choose a new output directory'
    args.output.mkdir(parents=True)
    binaries = {name: Path(path).resolve() for name, path in (value.split('=', 1) for value in args.binary)}
    if args.neovim is not None:
        oracle_manifest = json.loads((ROOT / 'tests/oracle/manifest.json').read_text())
        assert hashlib.sha256(args.neovim.read_bytes()).hexdigest() == oracle_manifest['oracle']['binarySha256']
        binaries['neovim'] = args.neovim.resolve()
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in binaries.items()}
    report = dict(classification='diagnostic-parsed-correct-frame', reference_host=False, scenario=args.scenario,
        producer_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        environment=dict(platform=platform.platform(), python=sys.version, width=args.width, height=40),
        binaries={name: str(path) for name, path in binaries.items()}, binary_hashes=hashes,
        sessions=[], limitations=['Shared host; no physical key-to-photon measurement.',
            'One small-source corpus and one real task-output load; not the complete service/action/size matrix.',
            'Fresh processes, warm filesystem. Startup includes VT parsing; timed input completion uses captured PTY arrival timestamps validated afterward.',
            'Input producer uses absolute deadlines in an independent process; injection slippage is retained. Producer is prepared before application startup.',
            'Process RSS/HWM are snapshots, not allocation rates or child-process memory.'])
    rng = random.Random(135)
    for session in range(args.sessions):
        conditions = [(name, load) for name in binaries for load in ([False, True] if args.load == 'both' else [args.load == 'task'])]
        conditions = [(name, load) for name, load in conditions if name != 'neovim' or not load]
        rng.shuffle(conditions)
        for name, load in conditions:
            directory = args.output / f'{session:02}-{name}-{"task" if load else "idle"}'
            row = dict(session=session, variant=name, load='task' if load else 'idle')
            try: row.update(trial(binaries[name], load, directory, args.width, args.scenario, name == 'neovim'))
            except Exception as error:
                row.update(correct=False, error=repr(error))
                report['sessions'].append(row)
                (args.output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
                raise
            report['sessions'].append(row)
            (args.output / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
            print(f'{session + 1}/{args.sessions} {name} {row["load"]}: correct, startup {row["startup_ms"]:.1f} ms', flush=True)
    assert hashes == {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in binaries.items()}


if __name__ == '__main__':
    main()
