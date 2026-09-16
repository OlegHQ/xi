import { strict as assert } from 'node:assert';
import { compilePattern, createPatternTextSnapshot, findAllMatches } from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

const cases = [
  { id: 'repeated-start-marker', pattern: String.raw`foo\zsbar\zsqux`, text: 'foobarqux' },
  { id: 'repeated-end-marker', pattern: String.raw`foo\zebar\zequx`, text: 'foobarqux' },
  { id: 'nested-start-markers', pattern: String.raw`\(foo\zs\(bar\zs\)\)qux`, text: 'foobarqux' },
  { id: 'both-start-and-end-markers', pattern: String.raw`foo\zsbar\zebaz`, text: 'foobarbaz' },
] as const;
const luaCases = cases.map((test) =>
  `{ id='${test.id}', pattern=string.char(${luaBytes(test.pattern)}), text=string.char(${luaBytes(test.text)}) }`,
).join(',');
const lua = `local cases={${luaCases}}; local results={}; for _,c in ipairs(cases) do table.insert(results,{id=c.id,span=vim.fn.matchstrpos(c.text,c.pattern)}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(results)})`;
const fixture: OracleFixture = {
  id: 'PATT-T096-REPORTED-SPAN-ORACLE-01',
  title: 'Compare repeated and nested reported-span markers with the pinned oracle',
  purpose: 'Direct matchstrpos oracle for the last encountered `\\zs`/`\\ze` and their interaction.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe reported spans', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
const observed = await runOracleFixture(fixture, binaryPath);
const encoded = observed.snapshots[0]?.lines[0];
assert(encoded !== undefined);
const expected = JSON.parse(encoded) as readonly {
  readonly id: string;
  readonly span: readonly [string, number, number];
}[];
assert.equal(expected.length, cases.length);

for (let index = 0; index < cases.length; index += 1) {
  const test = cases[index];
  const oracle = expected[index];
  assert(test !== undefined && oracle !== undefined);
  assert.equal(oracle.id, test.id);
  const result = findAllMatches(compilePattern(test.pattern), createPatternTextSnapshot(1 as DocumentVersion, test.text));
  assert.equal(result.engine, 'nfa');
  const match = result.matches[0];
  assert(match !== undefined, `${test.id}: Xi missed the oracle match`);
  assert.deepEqual([match.start as number, match.end as number], [oracle.span[1], oracle.span[2]], test.id);
}

console.log(`PASS ${fixture.id}: Neovim ${manifest.oracle.version} repeated/nested reported-span cases=${cases.length}; binary=${manifest.oracle.binarySha256}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}
