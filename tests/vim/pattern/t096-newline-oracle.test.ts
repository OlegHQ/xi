import { strict as assert } from 'node:assert';
import { compilePattern, createPatternTextSnapshot, substituteAll } from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

interface NewlineCase {
  readonly id: string;
  readonly pattern: string;
  readonly lines: readonly string[];
}

const newlineClassEscapes = ['i', 'I', 'k', 'K', 'f', 'F', 'p', 'P', 's', 'S', 'd', 'D', 'x', 'X', 'o', 'O', 'w', 'W', 'h', 'H', 'a', 'A', 'l', 'L', 'u', 'U'];
const newlineClassCases: readonly NewlineCase[] = newlineClassEscapes.map((escape) => ({
  id: `newline-builtin-class-${escape}`,
  pattern: `\\_${escape}`,
  lines: ['A0 _-./:@!\t', 'B8'],
}));
const cases: readonly NewlineCase[] = [
  { id: 'line-start-atom', pattern: String.raw`\_^b`, lines: ['a', 'b'] },
  { id: 'line-end-atom', pattern: String.raw`a\_$`, lines: ['a', 'b'] },
  { id: 'line-start-after-explicit-newline', pattern: String.raw`a\n^b`, lines: ['a', 'b'] },
  { id: 'line-end-before-explicit-newline', pattern: String.raw`a$\nb`, lines: ['a', 'b'] },
  { id: 'line-end-anchor-cannot-consume-following-character', pattern: String.raw`a\_$b`, lines: ['a', 'b'] },
  { id: 'newline-inclusive-space', pattern: String.raw`foo\_s\+bar`, lines: ['foo', 'bar foo bar'] },
  { id: 'newline-inclusive-dot', pattern: String.raw`a\_.b`, lines: ['a', 'b'] },
  { id: 'newline-inclusive-class', pattern: String.raw`\_[ab]`, lines: ['a', 'b'] },
  { id: 'newline-only-class', pattern: String.raw`\_[c]`, lines: ['a', 'b'] },
  { id: 'newline-inclusive-negated-class', pattern: String.raw`\_[^a]`, lines: ['x', 'b'] },
  { id: 'explicit-newline', pattern: String.raw`a\nb`, lines: ['a', 'b'] },
  ...newlineClassCases,
];
const luaCases = cases.map((fixture) => {
  const lines = fixture.lines.map((line) => `string.char(${luaBytes(line)})`).join(',');
  return `{ id=${luaQuote(fixture.id)}, pattern=string.char(${luaBytes(`\\m${fixture.pattern}`)}), lines={${lines}} }`;
}).join(',');
const lua = `local cases={${luaCases}}; local results={}; for _,c in ipairs(cases) do local text=table.concat(c.lines,'\\n'); local spans={}; for i=0,#text do table.insert(spans,vim.fn.matchstrpos(text,c.pattern,i)) end; vim.api.nvim_buf_set_lines(0,0,-1,true,c.lines); pcall(vim.cmd,'%s/'..c.pattern..'/X/g'); table.insert(results,{id=c.id,lines=vim.api.nvim_buf_get_lines(0,0,-1,true),spans=spans}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(results)})`;
const fixture: OracleFixture = {
  id: 'PATT-T096-NEWLINE-ORACLE-01',
  title: 'Compare newline anchors and newline-inclusive regular atoms/classes',
  purpose: 'Pinned buffer substitute oracle for cross-line regular pattern behavior.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe multiline dialect cases', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
const observed = await runOracleFixture(fixture, binaryPath);
const encoded = observed.snapshots[0]?.lines[0];
assert(encoded !== undefined);
const expected = JSON.parse(encoded) as readonly { readonly id: string; readonly lines: readonly string[]; readonly spans: readonly (readonly [string, number, number])[] }[];
assert.equal(expected.length, cases.length);

for (let index = 0; index < cases.length; index += 1) {
  const test = cases[index];
  const oracle = expected[index];
  assert(test !== undefined && oracle !== undefined);
  assert.equal(oracle.id, test.id);
  const result = substituteAll(
    compilePattern(test.pattern),
    createPatternTextSnapshot(1 as DocumentVersion, test.lines.join('\n')),
    'X',
  );
  assert.equal(result.engine, 'nfa');
  if (test.id.includes('class')) {
    const observedSpans = result.matches.map((match) => [match.start as number, match.end as number]);
    const expectedSpans = oracle.spans.flatMap((span) => span[1] < 0 ? [] : [[span[1], span[2]]]);
    const uniqueExpected = expectedSpans.filter((span, index) => expectedSpans.findIndex((candidate) => candidate[0] === span[0] && candidate[1] === span[1]) === index);
    assert.deepEqual(observedSpans, uniqueExpected, test.id);
  } else {
    assert.deepEqual(result.text.split('\n'), oracle.lines, test.id);
  }
}

console.log(`PASS ${fixture.id}: Neovim ${manifest.oracle.version} newline cases=${cases.length}; binary=${manifest.oracle.binarySha256}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}

function luaQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
