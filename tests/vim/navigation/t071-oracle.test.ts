#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const fixture: OracleFixture = {
  id: 'T071-ORACLE-HOST-JUMP-01',
  title: 'Native file jump and split jump',
  purpose: 'Pin gf-family target selection, split-window creation and gF line selection.',
  modes: ['normal'],
  lines: ['other.ts:3'],
  initialFile: 'main.ts',
  hostFiles: [{ path: 'other.ts', lines: ['one', 'two', 'three'] }],
  steps: [
    { label: 'split-file', keys: '<C-W>f' },
    { label: 'line-file', keys: '<C-W>wgF' },
  ],
};

const oracle = await verifyOracleBundle();
const result = await runOracleFixture(fixture, oracle.binaryPath);
assert.equal(result.snapshots.length, 2, 'T071-ORACLE-HOST-JUMP-01 retains both host navigation snapshots');
const split = result.snapshots[0];
const line = result.snapshots[1];
assert.ok(split !== undefined && line !== undefined, 'T071-ORACLE-HOST-JUMP-01 snapshots are present');
if (split === undefined || line === undefined) throw new Error('missing T071 oracle snapshot');
assert.equal(split.buffer.name?.toString().endsWith('/other.ts'), true, 'T071-ORACLE-HOST-JUMP-01 Ctrl-W f opens the target buffer');
assert.equal(split.cursor.line, 1, 'T071-ORACLE-HOST-JUMP-01 split file opens at its first line');
assert.equal(line.buffer.name?.toString().endsWith('/other.ts'), true, 'T071-ORACLE-HOST-JUMP-01 gF retains the target buffer');
assert.equal(line.cursor.line, 3, 'T071-ORACLE-HOST-JUMP-01 gF selects the requested one based line');
console.log(`T071 pinned host navigation oracle passed on Neovim ${oracle.manifest.oracle.version}: split and gF cursor behavior match`);
