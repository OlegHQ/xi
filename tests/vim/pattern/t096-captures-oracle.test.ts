import { strict as assert } from 'node:assert';
import { compilePattern, createPatternTextSnapshot, findAllMatches, PatternEvaluationError } from '../../../packages/vim/pattern/index';
import type { CaptureSpan } from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

interface CaptureCase {
  readonly id: string;
  readonly pattern: string;
  readonly text: string;
}

const cases: readonly CaptureCase[] = [
  { id: 'nine-captures', pattern: String.raw`\v(a)(b)(c)(d)(e)(f)(g)(h)(i)`, text: 'abcdefghi' },
  { id: 'alternate-clears-unparticipating-group', pattern: String.raw`\v(a|(b))`, text: 'a' },
  { id: 'repeat-clears-capture-from-earlier-iteration', pattern: String.raw`\v(a(b)?)+`, text: 'aba' },
  { id: 'ordered-alternation-capture', pattern: String.raw`\v(a|ab)`, text: 'ab' },
];
const luaCases = cases.map((test) =>
  `{ id='${test.id}', pattern=string.char(${luaBytes(test.pattern)}), text=string.char(${luaBytes(test.text)}) }`,
).join(',');
const lua = `local cases={${luaCases}}; local results={}; for _,c in ipairs(cases) do table.insert(results,{id=c.id,span=vim.fn.matchstrpos(c.text,c.pattern),captures=vim.fn.matchlist(c.text,c.pattern)}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(results)})`;
const fixture: OracleFixture = {
  id: 'PATT-T096-CAPTURE-PRIORITY-ORACLE-01',
  title: 'Compare regular capture participation and priority with the pinned oracle',
  purpose: 'Direct matchstrpos/matchlist oracle for nine groups, alternation participation and repeat clearing.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe regular captures', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
const observed = await runOracleFixture(fixture, binaryPath);
const encoded = observed.snapshots[0]?.lines[0];
assert(encoded !== undefined);
const expected = JSON.parse(encoded) as readonly {
  readonly id: string;
  readonly span: readonly [string, number, number];
  readonly captures: readonly string[];
}[];
assert.equal(expected.length, cases.length);

for (let index = 0; index < cases.length; index += 1) {
  const test = cases[index];
  const oracle = expected[index];
  assert(test !== undefined && oracle !== undefined);
  assert.equal(oracle.id, test.id);
  const result = findAllMatches(compilePattern(test.pattern), createPatternTextSnapshot(1 as DocumentVersion, test.text));
  assert.equal(result.engine, 'nfa', `${test.id}: regular capture pattern must use NFA`);
  const match = result.matches[0];
  assert(match !== undefined, `${test.id}: Xi missed the oracle match`);
  assert.deepEqual([match.start as number, match.end as number], [oracle.span[1], oracle.span[2]], `${test.id}: whole match span`);
  for (let group = 1; group <= 9; group += 1) {
    const capture: CaptureSpan | undefined = match.captures.get(group);
    const value: string = capture === undefined ? '' : test.text.slice(capture.start as number, capture.end as number);
    assert.equal(value, oracle.captures[group] ?? '', `${test.id}: capture ${group}`);
  }
}

const tooManyCaptures = String.raw`\v(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)`;
const overflowLua = `local ok=pcall(vim.fn.matchstrpos,'abcdefghij',string.char(${luaBytes(tooManyCaptures)})); vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode({accepted=ok})})`;
const overflowFixture: OracleFixture = {
  id: 'PATT-T096-CAPTURE-LIMIT-ORACLE-01',
  title: 'Compare Vim capture group limit with the production parser',
  purpose: 'Pinned oracle check that only nine capturing groups are accepted.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'reject tenth capture', keys: `:lua ${overflowLua}<CR>` }],
};
const overflowObservation = await runOracleFixture(overflowFixture, binaryPath);
const overflowJson = overflowObservation.snapshots[0]?.lines[0];
assert(overflowJson !== undefined);
assert.equal((JSON.parse(overflowJson) as { readonly accepted: boolean }).accepted, false, 'Neovim must reject more than nine captures');
assert.throws(() => compilePattern(tooManyCaptures), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'invalid-pattern' && error.source !== undefined,
  'Xi must reject excess captures with a typed source span',
);

console.log(`PASS ${fixture.id}: Neovim ${manifest.oracle.version} cases=${cases.length}; captures=1..9, participation and priority match; binary=${manifest.oracle.binarySha256}`);
console.log(`PASS ${overflowFixture.id}: Neovim and Xi reject captures above nine with source-aware Xi failure`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}
