import { strict as assert } from 'node:assert';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import {
  applyVimOptionChanges,
  compileVimMappings,
  createVimOptionState,
  flushVimMapping,
  initialVimMappingState,
  resolveVimMapping,
  type VimOptionName,
} from '../../../packages/vim/config/index';

const oracle = await verifyOracleBundle();

checkProfilesAndNativeReservations();
checkRecursiveAndNonrecursiveMappings();
checkPrefixTimeoutAndFlush();
checkVersionedOptions();
await checkPinnedMappingBehavior();
await checkPinnedOptionBehavior();

console.log('T032 config mappings/options passed: profiles, recursion, prefix timeout, versioning and pinned oracle rows');

function checkProfilesAndNativeReservations(): void {
  for (const lhs of [['U'], ['>'], ['g', 'd'], ['<Space>']] as const) {
    const result = compileVimMappings('strict', [{ mode: 'normal', lhs, rhs: ['x'] }]);
    assert.deepEqual(result, {
      ok: false,
      error: { kind: 'native-key-collision', mode: 'normal', lhs },
    }, `T032-PROFILE-STRICT-${lhs.join('-')}-01 strict preserves native mapping`);
  }

  const strict = compileVimMappings('strict', [{ mode: 'normal', lhs: ['x'], rhs: ['y'] }]);
  assert.equal(strict.ok, true, 'T032-PROFILE-STRICT-01 unrelated custom map is allowed');
  const xiLeader = compileVimMappings('xi', [{ mode: 'normal', lhs: ['<Space>', 'm', 'a'], rhs: ['<Xi:selection-add>'] }]);
  assert.equal(xiLeader.ok, true, 'T032-PROFILE-XI-01 leader mapping is allowed');
  const xiNative = compileVimMappings('xi', [{ mode: 'normal', lhs: ['U'], rhs: ['x'] }]);
  assert.deepEqual(xiNative, {
    ok: false,
    error: { kind: 'native-key-collision', mode: 'normal', lhs: ['U'] },
  }, 'T032-PROFILE-XI-02 Xi cannot shadow native U');
  const personal = compileVimMappings('personal', [{ mode: 'normal', lhs: ['U'], rhs: ['x'] }]);
  assert.equal(personal.ok, true, 'T032-PROFILE-PERSONAL-01 personal may opt into non-native U mapping');

  if (!strict.ok) return;
  let state = initialVimMappingState('normal');
  const native = resolveVimMapping(strict.value, state, 'U', 0);
  assert.deepEqual(native, { kind: 'passthrough', state: initialVimMappingState('normal'), keys: ['U'] },
    'T032-PROFILE-STRICT-02 U remains native passthrough');
  state = initialVimMappingState('normal');
  const unrelated = resolveVimMapping(strict.value, state, 'x', 0);
  assert.deepEqual(unrelated, {
    kind: 'expanded', state: initialVimMappingState('normal'), keys: ['y'],
    mapping: strict.value.mappings[0],
  }, 'T032-PROFILE-STRICT-03 unrelated mapping expands');
}

function checkRecursiveAndNonrecursiveMappings(): void {
  const nonrecursive = compileVimMappings('personal', [
    { mode: 'normal', lhs: ['x'], rhs: ['y'], recursive: false },
    { mode: 'normal', lhs: ['y'], rhs: ['z'], recursive: true },
  ]);
  assert.equal(nonrecursive.ok, true, 'T032-MAP-RECURSION-01 nonrecursive table compiles');
  if (!nonrecursive.ok) return;
  const nonrecursiveResult = resolveVimMapping(nonrecursive.value, initialVimMappingState('normal'), 'x', 0);
  assert.equal(nonrecursiveResult.kind, 'expanded', 'T032-MAP-RECURSION-02 nonrecursive map resolves');
  if (nonrecursiveResult.kind === 'expanded') assert.deepEqual(nonrecursiveResult.keys, ['y'], 'T032-MAP-RECURSION-03 noremap does not remap RHS');

  const recursive = compileVimMappings('personal', [
    { mode: 'normal', lhs: ['x'], rhs: ['y'], recursive: true },
    { mode: 'normal', lhs: ['y'], rhs: ['z'], recursive: true },
  ]);
  assert.equal(recursive.ok, true, 'T032-MAP-RECURSION-04 recursive table compiles');
  if (!recursive.ok) return;
  const recursiveResult = resolveVimMapping(recursive.value, initialVimMappingState('normal'), 'x', 0);
  assert.equal(recursiveResult.kind, 'expanded', 'T032-MAP-RECURSION-05 recursive map resolves');
  if (recursiveResult.kind === 'expanded') assert.deepEqual(recursiveResult.keys, ['z'], 'T032-MAP-RECURSION-06 recursive RHS re-enters mappings');

  const loop = compileVimMappings('personal', [
    { mode: 'normal', lhs: ['x'], rhs: ['y'], recursive: true },
    { mode: 'normal', lhs: ['y'], rhs: ['x'], recursive: true },
  ], { maxRecursion: 8 });
  assert.equal(loop.ok, true, 'T032-MAP-RECURSION-07 loop table compiles for runtime detection');
  if (!loop.ok) return;
  const loopResult = resolveVimMapping(loop.value, initialVimMappingState('normal'), 'x', 0);
  assert.deepEqual(loopResult.kind, 'failed', 'T032-MAP-RECURSION-08 loop is rejected at expansion');
  if (loopResult.kind === 'failed') assert.equal(loopResult.failure.kind, 'mapping-recursion', 'T032-MAP-RECURSION-09 loop failure is typed');

  const mode = compileVimMappings('personal', [{ mode: 'normal', lhs: ['x'], rhs: ['y'] }]);
  assert.equal(mode.ok, true, 'T032-MAP-MODE-01 mode table compiles');
  if (mode.ok) {
    const insert = resolveVimMapping(mode.value, initialVimMappingState('insert'), 'x', 0);
    assert.deepEqual(insert, { kind: 'passthrough', state: initialVimMappingState('insert'), keys: ['x'] },
      'T032-MAP-MODE-02 normal map does not affect insert');
  }
}

function checkPrefixTimeoutAndFlush(): void {
  const table = compileVimMappings('personal', [
    { mode: 'normal', lhs: ['g'], rhs: ['A'] },
    { mode: 'normal', lhs: ['g', 'g'], rhs: ['B'] },
  ], { timeoutMilliseconds: 100 });
  assert.equal(table.ok, true, 'T032-MAP-TIMEOUT-01 exact-prefix table compiles');
  if (!table.ok) return;
  let state = initialVimMappingState('normal');
  const first = resolveVimMapping(table.value, state, 'g', 0);
  assert.equal(first.kind, 'pending', 'T032-MAP-TIMEOUT-02 ambiguous exact prefix waits');
  if (first.kind !== 'pending') return;
  state = first.state;
  const unresolved = flushVimMapping(table.value, state, 50);
  assert.equal(unresolved.kind, 'pending', 'T032-MAP-TIMEOUT-03 prefix remains pending before timeout');
  const expired = flushVimMapping(table.value, state, 100);
  assert.equal(expired.kind, 'expanded', 'T032-MAP-TIMEOUT-04 exact prefix resolves at timeout');
  if (expired.kind === 'expanded') assert.deepEqual(expired.keys, ['A'], 'T032-MAP-TIMEOUT-05 timeout selects short exact mapping');

  state = initialVimMappingState('normal');
  const second = resolveVimMapping(table.value, state, 'g', 0);
  assert.equal(second.kind, 'pending', 'T032-MAP-TIMEOUT-06 second prefix starts pending state');
  if (second.kind !== 'pending') return;
  const exact = resolveVimMapping(table.value, second.state, 'g', 50);
  assert.equal(exact.kind, 'expanded', 'T032-MAP-TIMEOUT-07 longer exact mapping wins before timeout');
  if (exact.kind === 'expanded') assert.deepEqual(exact.keys, ['B'], 'T032-MAP-TIMEOUT-08 longer mapping output is selected');

  state = initialVimMappingState('normal');
  const third = resolveVimMapping(table.value, state, 'g', 0);
  assert.equal(third.kind, 'pending', 'T032-MAP-TIMEOUT-09 unrelated suffix starts from prefix');
  if (third.kind !== 'pending') return;
  const suffix = resolveVimMapping(table.value, third.state, 'h', 50);
  assert.equal(suffix.kind, 'expanded', 'T032-MAP-TIMEOUT-10 unrelated key flushes exact mapping');
  if (suffix.kind === 'expanded') assert.deepEqual(suffix.keys, ['A', 'h'], 'T032-MAP-TIMEOUT-11 timeout preserves suffix as native input');
}

function checkVersionedOptions(): void {
  const initial = createVimOptionState('strict');
  assert.equal(initial.ok, true, 'T032-OPTION-VERSION-01 strict defaults compile');
  if (!initial.ok) return;
  assert.equal(initial.value.version, 0, 'T032-OPTION-VERSION-02 initial options start at version zero');
  assert.equal(initial.value.values.joinspaces, false, 'T032-OPTION-DEFAULT-01 pinned joinspaces default is false');
  assert.equal(initial.value.values.startofline, false, 'T032-OPTION-DEFAULT-02 pinned startofline default is false');
  assert.equal(initial.value.values.whichwrap, 'b,s', 'T032-OPTION-DEFAULT-03 pinned whichwrap default is b,s');

  const changed = applyVimOptionChanges(initial.value, {
    expectedVersion: 0,
    changes: [
      { name: 'tabstop', value: 4, scope: 'buffer' },
      { name: 'shiftwidth', value: 2, scope: 'buffer' },
      { name: 'joinspaces', value: true, scope: 'buffer' },
    ],
  });
  assert.equal(changed.ok, true, 'T032-OPTION-VERSION-04 valid option batch commits');
  if (!changed.ok) return;
  assert.equal(changed.value.version, 1, 'T032-OPTION-VERSION-05 option batch increments version');
  assert.equal(changed.value.values.tabstop, 4, 'T032-OPTION-VERSION-06 tabstop update is visible');
  const stale = applyVimOptionChanges(changed.value, { expectedVersion: 0, changes: [{ name: 'wrap', value: false }] });
  assert.deepEqual(stale, { ok: false, error: { kind: 'stale-version', expected: 0, actual: 1 } }, 'T032-OPTION-VERSION-07 stale option update is rejected');
  const scope = applyVimOptionChanges(changed.value, { expectedVersion: 1, changes: [{ name: 'tabstop', value: 8, scope: 'global' }] });
  assert.deepEqual(scope, { ok: false, error: { kind: 'scope-collision', name: 'tabstop', expected: 'buffer', received: 'global' } }, 'T032-OPTION-SCOPE-01 local/global collision is rejected');
  const invalid = applyVimOptionChanges(changed.value, { expectedVersion: 1, changes: [{ name: 'tabstop', value: 0 }] });
  assert.deepEqual(invalid, { ok: false, error: { kind: 'invalid-value', name: 'tabstop' } }, 'T032-OPTION-VALUE-01 invalid tabstop is rejected');
  const unknown = applyVimOptionChanges(changed.value, { expectedVersion: 1, changes: [{ name: 'does-not-exist' as VimOptionName, value: true }] });
  assert.deepEqual(unknown, { ok: false, error: { kind: 'invalid-option', name: 'does-not-exist' } }, 'T032-OPTION-VALUE-02 unknown option is rejected');
}

async function checkPinnedMappingBehavior(): Promise<void> {
  const fixture = await runOracleFixture({
    id: 'T032-MAP-ORACLE-NATIVE-DELETE-01',
    title: 'Recursive mapping expands to a native delete command',
    purpose: 'Compare a normal-mode mapping to pinned Neovim input.',
    modes: ['normal'],
    lines: ['one', 'two', 'three'],
    mappings: [{ mode: 'n', lhs: 'x', rhs: 'dd', remap: true }],
    steps: [{ label: 'mapped-delete', keys: 'x' }],
  }, oracle.binaryPath);
  const snapshot = fixture.snapshots[0];
  assert.ok(snapshot, 'T032-MAP-ORACLE-01 pinned mapping snapshot exists');
  if (snapshot === undefined) return;
  assert.deepEqual(snapshot.lines, ['two', 'three'], 'T032-MAP-ORACLE-02 pinned recursive mapping deletes one line');

  const table = compileVimMappings('personal', [{ mode: 'normal', lhs: ['x'], rhs: ['d', 'd'], recursive: true }]);
  assert.equal(table.ok, true, 'T032-MAP-ORACLE-03 Xi mapping equivalent compiles');
  if (!table.ok) return;
  const result = resolveVimMapping(table.value, initialVimMappingState('normal'), 'x', 0);
  assert.equal(result.kind, 'expanded', 'T032-MAP-ORACLE-04 Xi mapping expands');
  if (result.kind === 'expanded') assert.deepEqual(result.keys, ['d', 'd'], 'T032-MAP-ORACLE-05 Xi output matches native mapping RHS');
}

async function checkPinnedOptionBehavior(): Promise<void> {
  const options = {
    backspace: 'indent,eol,start', cpoptions: 'aABceFs_', expandtab: true,
    iskeyword: '@,48-57,_,192-255,-', joinspaces: true, nrformats: 'bin,hex',
    scrolloff: 3, selection: 'exclusive', shiftwidth: 2, startofline: true,
    tabstop: 4, timeoutlen: 321,
  } as const;
  const fixture = await runOracleFixture({
    id: 'T032-OPTION-ORACLE-PROFILE-01',
    title: 'Versioned strict option changes',
    purpose: 'Capture changed Vim options against the pinned defaults.',
    modes: ['normal'],
    lines: ['one'],
    options,
    steps: [{ label: 'changed-options', drain: true }],
  }, oracle.binaryPath);
  const snapshot = fixture.snapshots[0];
  assert.ok(snapshot, 'T032-OPTION-ORACLE-01 pinned option snapshot exists');
  if (snapshot === undefined) return;
  const initial = createVimOptionState('strict');
  assert.equal(initial.ok, true, 'T032-OPTION-ORACLE-02 strict state starts');
  if (!initial.ok) return;
  const changes = Object.entries(options).map(([name, value]) => ({ name: name as VimOptionName, value }));
  const state = applyVimOptionChanges(initial.value, { expectedVersion: 0, changes });
  assert.equal(state.ok, true, 'T032-OPTION-ORACLE-03 changed options commit');
  if (!state.ok) return;
  for (const name of Object.keys(options) as VimOptionName[]) {
    assert.equal(state.value.values[name], snapshot.options[name], `T032-OPTION-ORACLE-04 ${name} matches Neovim`);
  }
}
