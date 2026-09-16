#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const oracle = await verifyOracleBundle();
const fixtures: readonly OracleFixture[] = [
  {
    id: 'T104-ORACLE-NRFORMATS-HEX-01', title: 'Ctrl-A increments a hexadecimal number',
    purpose: 'Pin nrformats hex handling against the development oracle.', modes: ['normal'],
    lines: ['0x0f 007 0b11'], options: { nrformats: 'bin,hex' }, cursor: { line: 1, byteColumn0: 0 },
    steps: [{ label: 'increment-hex', keys: '<C-A>' }],
  },
  {
    id: 'T104-ORACLE-NRFORMATS-DECIMAL-01', title: 'Ctrl-X decrements a decimal number',
    purpose: 'Pin decimal decrement and leading-zero width against the development oracle.', modes: ['normal'],
    lines: ['007'], options: { nrformats: 'bin,hex' }, cursor: { line: 1, byteColumn0: 0 },
    steps: [{ label: 'decrement-decimal', keys: '<C-X>' }],
  },
];
const expected = [['0x10 007 0b11'], ['006']];
for (let index = 0; index < fixtures.length; index += 1) {
  const result = await runOracleFixture(fixtures[index]!, oracle.binaryPath);
  const snapshot = result.snapshots.at(-1);
  assert.notEqual(snapshot, undefined, `T104-ORACLE-${index}-01 snapshot exists`);
  if (snapshot !== undefined) assert.deepEqual(snapshot.lines, expected[index], `T104-ORACLE-${index}-02 output matches Neovim`);
}
console.log(`T104 oracle passed ${fixtures.length} pinned nrformats fixtures`);
