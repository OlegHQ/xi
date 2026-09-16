#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { runOracleFixture, runUiOracleFixture, verifyOracleBundle } from './oracle-runner';
import type { OracleFixture, OracleSnapshot } from './types';

const oracle = await verifyOracleBundle();

function fixture(id: string, plus: string, star: readonly string[]): OracleFixture {
  return {
    id,
    title: 'Fixture-local clipboard state',
    purpose: 'Prove isolated plus/star provider state and ordinary unnamed-register semantics.',
    modes: ['normal'],
    lines: ['one', 'two'],
    clipboard: {
      plus: { lines: [plus], type: 'v' },
      star: { lines: star, type: 'V' },
    },
    steps: [
      { label: 'seeded-registers', drain: true },
      { label: 'copy-to-plus', keys: '"+yy' },
      { label: 'copy-to-star', keys: '"*yy' },
      { label: 'copy-to-unnamed', keys: 'yy' },
      { label: 'paste-plus', keys: 'G"+P' },
      { label: 'paste-star', keys: 'gg"*p' },
    ],
  };
}

const alpha = fixture('T121-CLIPBOARD-ALPHA', 'seed-plus-alpha', ['seed-star-alpha', 'tail']);
const beta = fixture('T121-CLIPBOARD-BETA', 'seed-plus-beta', ['seed-star-beta', 'tail']);

const previousVariant = process.env.XI_ORACLE_EXTERNAL_CLIPBOARD_VARIANT;
try {
  process.env.XI_ORACLE_EXTERNAL_CLIPBOARD_VARIANT = 'sentinel-alpha';
  const alphaFirst = await runOracleFixture(alpha, oracle.binaryPath);
  const betaSecond = await runOracleFixture(beta, oracle.binaryPath);

  process.env.XI_ORACLE_EXTERNAL_CLIPBOARD_VARIANT = 'sentinel-beta';
  const betaFirst = await runOracleFixture(beta, oracle.binaryPath);
  const alphaSecond = await runOracleFixture(alpha, oracle.binaryPath);

  assert.deepEqual(snapshotShape(alphaFirst), snapshotShape(alphaSecond),
    'T121-CLIPBOARD-ORDER-01 alpha is independent of fixture order and external variant');
  assert.deepEqual(snapshotShape(betaSecond), snapshotShape(betaFirst),
    'T121-CLIPBOARD-ORDER-02 beta is independent of fixture order and external variant');
  assertClipboardSemantics(alphaFirst.snapshots, alpha.clipboard);
  assertClipboardSemantics(betaFirst.snapshots, beta.clipboard);

  const ui = await runUiOracleFixture({
    ...alpha,
    id: 'T121-CLIPBOARD-UI',
    steps: [{ label: 'copy-to-plus', keys: '"+yy' }],
  }, oracle.binaryPath);
  assert.equal(ui.terminalRestored, true, 'T121-CLIPBOARD-UI-01 terminal state is restored');
  assert.deepEqual(ui.snapshot.registers['+'], { lines: ['one'], type: 'V' },
    'T121-CLIPBOARD-UI-02 UI startup uses fixture-local plus provider');
  assert.deepEqual(ui.snapshot.registers['*'], { lines: ['seed-star-alpha', 'tail'], type: 'V' },
    'T121-CLIPBOARD-UI-03 UI startup preserves independent star state');
  console.log('T121 clipboard isolation passed: headless order/variant matrix, explicit +/* copy/paste, unnamed semantics, UI startup, and terminal restoration');
} finally {
  if (previousVariant === undefined) delete process.env.XI_ORACLE_EXTERNAL_CLIPBOARD_VARIANT;
  else process.env.XI_ORACLE_EXTERNAL_CLIPBOARD_VARIANT = previousVariant;
}

function assertClipboardSemantics(snapshots: readonly OracleSnapshot[], seed: OracleFixture['clipboard']): void {
  const initial = snapshots[0];
  const plusCopy = snapshots[1];
  const starCopy = snapshots[2];
  const unnamedCopy = snapshots[3];
  const plusPaste = snapshots[4];
  const starPaste = snapshots[5];
  assert.ok(initial && plusCopy && starCopy && unnamedCopy && plusPaste && starPaste);
  if (!initial || !plusCopy || !starCopy || !unnamedCopy || !plusPaste || !starPaste) return;
  assert.deepEqual(initial.registers['+'], seed?.plus, 'T121-CLIPBOARD-HEADLESS-01 plus seed is installed before capture');
  assert.deepEqual(initial.registers['*'], seed?.star, 'T121-CLIPBOARD-HEADLESS-02 star seed is installed before capture');
  assert.deepEqual(plusCopy.registers['+'], { lines: ['one'], type: 'V' }, 'T121-CLIPBOARD-HEADLESS-03 explicit plus yank');
  assert.deepEqual(plusCopy.registers['*'], seed?.star, 'T121-CLIPBOARD-HEADLESS-04 plus yank leaves star unchanged');
  assert.deepEqual(starCopy.registers['*'], { lines: ['one'], type: 'V' }, 'T121-CLIPBOARD-HEADLESS-05 explicit star yank');
  assert.deepEqual(starCopy.registers['+'], { lines: ['one'], type: 'V' }, 'T121-CLIPBOARD-HEADLESS-06 star yank leaves plus unchanged');
  assert.deepEqual(unnamedCopy.registers['"'], { lines: ['one'], type: 'V' }, 'T121-CLIPBOARD-HEADLESS-07 ordinary yank updates unnamed');
  assert.deepEqual(unnamedCopy.registers['+'], plusCopy.registers['+'], 'T121-CLIPBOARD-HEADLESS-08 unnamed yank leaves plus unchanged');
  assert.deepEqual(unnamedCopy.registers['*'], starCopy.registers['*'], 'T121-CLIPBOARD-HEADLESS-09 unnamed yank leaves star unchanged');
  assert.deepEqual(plusPaste.lines, ['one', 'one', 'two'], 'T121-CLIPBOARD-HEADLESS-10 plus paste uses plus payload');
  assert.deepEqual(starPaste.lines, ['one', 'one', 'one', 'two'], 'T121-CLIPBOARD-HEADLESS-11 star paste uses star payload');
}

function snapshotShape(result: Awaited<ReturnType<typeof runOracleFixture>>): readonly unknown[] {
  return result.snapshots.map((snapshot) => ({ lines: snapshot.lines, registers: snapshot.registers }));
}
