import { runUiOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const fixtures: readonly OracleFixture[] = [
  motion('T031-ORACLE-GJ-WRAP-01', ['    abcdefghijklmnop', 'short'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gj'),
  motion('T031-ORACLE-GK-WRAP-01', ['    abcdefghijklmnop', 'short'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 12 }, 'gk'),
  motion('T031-ORACLE-G0-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g0'),
  motion('T031-ORACLE-GCARET-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g^'),
  motion('T031-ORACLE-GDOLLAR-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g$'),
  motion('T031-ORACLE-GM-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gm'),
  motion('T031-ORACLE-GCAPM-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gM'),
  motion('T031-ORACLE-ZT-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zt'),
  motion('T031-ORACLE-ZZ-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zz'),
  motion('T031-ORACLE-ZB-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zb'),
  motion('T031-ORACLE-Z-BASE-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, '<Esc>'),
  motion('T031-ORACLE-H-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'H'),
  motion('T031-ORACLE-M-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'M'),
  motion('T031-ORACLE-L-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'L'),
  motion('T031-ORACLE-CTRL-F-01', numbered(30), { columns: 24, lines: 8 }, { line: 8, byteColumn0: 2 }, '\u0006'),
  motion('T031-ORACLE-CTRL-B-01', numbered(30), { columns: 24, lines: 8 }, { line: 16, byteColumn0: 2 }, '\u0002'),
  motion('T031-ORACLE-CTRL-F-BASE-01', numbered(30), { columns: 24, lines: 8 }, { line: 8, byteColumn0: 2 }, '<Esc>'),
  motion('T031-ORACLE-CTRL-B-BASE-01', numbered(30), { columns: 24, lines: 8 }, { line: 16, byteColumn0: 2 }, '<Esc>'),
  motion('T031-ORACLE-CTRL-D-01', numbered(30), { columns: 24, lines: 8 }, { line: 8, byteColumn0: 2 }, '\u0004'),
  motion('T031-ORACLE-CTRL-U-01', numbered(30), { columns: 24, lines: 8 }, { line: 16, byteColumn0: 2 }, '\u0015'),
  motion('T031-ORACLE-CTRL-E-01', numbered(30), { columns: 24, lines: 8 }, { line: 5, byteColumn0: 2 }, '\u0005'),
  motion('T031-ORACLE-CTRL-Y-01', numbered(30), { columns: 24, lines: 8 }, { line: 12, byteColumn0: 2 }, '\u0019'),
  motion('T031-ORACLE-CTRL-E-BASE-01', numbered(30), { columns: 24, lines: 8 }, { line: 5, byteColumn0: 2 }, '<Esc>'),
  motion('T031-ORACLE-CTRL-Y-BASE-01', numbered(30), { columns: 24, lines: 8 }, { line: 12, byteColumn0: 2 }, '<Esc>'),
  motion('T031-ORACLE-HORIZONTAL-SCROLL-01', ['012345678901234567890123456789'], { columns: 12, lines: 8, wrap: false, sidescrolloff: 2 }, { line: 1, byteColumn0: 0 }, 'l'.repeat(17)),
  motion('T031-ORACLE-SCROLLOFF-01', numbered(30), { columns: 24, lines: 8, scrolloff: 2 }, { line: 4, byteColumn0: 2 }, '8j'),
  motion('T031-ORACLE-WIDE-WRAP-01', ['ab界cdefghijklmnop'], { columns: 12, lines: 7 }, { line: 1, byteColumn0: 8 }, 'gj'),
  motion('T031-ORACLE-TINY-VIEWPORT-01', ['abcdefghijklmno', 'second', 'third', 'fourth'], { columns: 12, lines: 4 }, { line: 1, byteColumn0: 0 }, 'gj'),
  motion('T031-ORACLE-FOLD-DESTINATION-01', numbered(12), { columns: 20, lines: 8 }, { line: 1, byteColumn0: 0 }, ':set foldmethod=manual foldenable foldlevel=0<CR>:3,6fold<CR>3j'),
  motion('T031-ORACLE-RESIZE-SMALL-01', numbered(30), { columns: 15, lines: 6 }, { line: 20, byteColumn0: 4 }, ''),
  motion('T031-ORACLE-RESIZE-LARGE-01', numbered(30), { columns: 50, lines: 14 }, { line: 20, byteColumn0: 4 }, ''),
];

const oracle = await verifyOracleBundle();
for (const fixture of fixtures) {
  const result = await runUiOracleFixture(fixture, oracle.binaryPath, {
    readinessMarker: (fixture.lines[0] ?? '').trimStart().slice(0, 4),
    processTimeoutMs: 15_000,
    readinessTimeoutMs: 8_000,
  });
  if (!result.terminalRestored) throw new Error(`T031-ORACLE-RESTORE-01 ${fixture.id} did not restore the terminal`);
  const expectedColumns = fixture.options?.columns ?? 80;
  const expectedLines = fixture.options?.lines ?? 24;
  if (result.pty.columns !== expectedColumns || result.snapshot.geometry.columns !== expectedColumns
    || result.pty.rows !== expectedLines || result.snapshot.geometry.lines !== expectedLines) {
    throw new Error(`T031-ORACLE-GEOMETRY-01 ${fixture.id} requested=${expectedLines}x${expectedColumns} pty=${result.pty.rows}x${result.pty.columns} nvim=${result.snapshot.geometry.lines}x${result.snapshot.geometry.columns}`);
  }
  console.log(JSON.stringify({
    id: fixture.id,
    pty: result.pty,
    geometry: result.snapshot.geometry,
    cursor: result.snapshot.cursor,
    view: result.snapshot.view,
    options: result.snapshot.options,
    lines: result.snapshot.lines,
    transcriptPath: result.transcriptPath,
  }));
}

function motion(
  id: string,
  lines: readonly string[],
  options: Readonly<Record<string, string | number | boolean>>,
  cursor: { readonly line: number; readonly byteColumn0: number },
  keys: string,
): OracleFixture {
  return {
    id,
    title: 'T031 viewport-motion oracle probe',
    purpose: 'Establish geometry-matched pinned Neovim screen motion and viewport behavior.',
    modes: ['normal'],
    lines,
    cursor,
    options,
    steps: [{ label: 'motion', keys }],
  };
}

function numbered(count: number): readonly string[] {
  return Array.from({ length: count }, (_value, index) => `line ${String(index + 1).padStart(2, '0')} abcdefghijklmnop`);
}
