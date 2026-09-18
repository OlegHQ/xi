import { strict as assert } from 'node:assert';
import { compilePattern, createPatternTextSnapshot, substituteAll } from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

interface DialectCase {
  readonly id: string;
  readonly pattern: string;
  readonly text: string;
  readonly magic: boolean;
}

const cases: readonly DialectCase[] = [
  { id: 'magic-dot', pattern: '.', text: 'x.', magic: true },
  { id: 'magic-escaped-dot', pattern: String.raw`\.`, text: 'x.', magic: true },
  { id: 'nomagic-dot', pattern: '.', text: 'x.', magic: false },
  { id: 'nomagic-escaped-dot', pattern: String.raw`\.`, text: 'x.', magic: false },
  { id: 'magic-class', pattern: '[ab]', text: 'xaz', magic: true },
  { id: 'posix-alpha-class', pattern: '[[:alpha:]]', text: '42Ab!', magic: true },
  { id: 'nomagic-escaped-class', pattern: String.raw`\[ab]`, text: 'xaz', magic: false },
  { id: 'very-nomagic-escaped-class', pattern: String.raw`\V\[ab]`, text: 'xaz', magic: true },
  { id: 'magic-capture-alternative', pattern: String.raw`\(a\|ab\)\+`, text: 'ab', magic: true },
  { id: 'nomagic-capture-alternative', pattern: String.raw`\(a\|ab\)\+`, text: 'ab', magic: false },
  { id: 'noncapturing-group', pattern: String.raw`\%(a\|ab\)\+`, text: 'ab', magic: true },
  { id: 'very-magic-capture-alternative', pattern: String.raw`\v(a|ab)+`, text: 'ab', magic: true },
  { id: 'magic-escaped-plus', pattern: String.raw`a\+b`, text: 'aaab', magic: true },
  { id: 'magic-escaped-question', pattern: String.raw`a\?b`, text: 'ab aab', magic: true },
  { id: 'magic-escaped-equals', pattern: String.raw`a\=b`, text: 'ab aab', magic: true },
  { id: 'magic-literal-plus', pattern: 'a+b', text: 'a+b', magic: true },
  { id: 'nomagic-escaped-star', pattern: String.raw`a\*b`, text: 'aaab', magic: false },
  { id: 'nomagic-escaped-plus', pattern: String.raw`a\+b`, text: 'aaab', magic: false },
  { id: 'nomagic-escaped-question', pattern: String.raw`a\?b`, text: 'ab aab', magic: false },
  { id: 'nomagic-escaped-equals', pattern: String.raw`a\=b`, text: 'ab aab', magic: false },
  { id: 'nomagic-brace-repeat', pattern: String.raw`a\{2,3}b`, text: 'aab aaab', magic: false },
  { id: 'nomagic-literal-star', pattern: 'a*b', text: 'a*b', magic: false },
  { id: 'very-nomagic-literal-punctuation', pattern: String.raw`\V(a|ab)+`, text: '(a|ab)+', magic: true },
  { id: 'greedy-brace-repeat', pattern: String.raw`a\{1,3}b`, text: 'aaab aab', magic: true },
  { id: 'exact-brace-repeat', pattern: String.raw`a\{2}b`, text: 'aab aaab', magic: true },
  { id: 'open-brace-repeat', pattern: String.raw`a\{2,}b`, text: 'aab aaab', magic: true },
  { id: 'upper-bounded-brace-repeat', pattern: String.raw`a\{,2}b`, text: 'ab aab aaab', magic: true },
  { id: 'empty-brace-repeat', pattern: String.raw`a\{}b`, text: 'b ab aaab', magic: true },
  { id: 'shortest-brace-repeat', pattern: String.raw`a\{-1,3}b`, text: 'aaab aab', magic: true },
  { id: 'shortest-exact-brace-repeat', pattern: String.raw`a\{-2}b`, text: 'aab aaab', magic: true },
  { id: 'shortest-open-brace-repeat', pattern: String.raw`a\{-2,}b`, text: 'aab aaab', magic: true },
  { id: 'shortest-upper-bounded-brace-repeat', pattern: String.raw`a\{-,2}b`, text: 'ab aab aaab', magic: true },
  { id: 'shortest-star-brace-repeat', pattern: String.raw`a\{-}b`, text: 'b ab aaab', magic: true },
  { id: 'very-magic-question', pattern: String.raw`\va?b`, text: 'ab aab', magic: true },
  { id: 'very-magic-brace-repeat', pattern: String.raw`\va{2,3}b`, text: 'aab aaab', magic: true },
  { id: 'magic-anchor-and-literal-caret', pattern: String.raw`^\^`, text: '^xq^', magic: true },
  { id: 'word-start-boundary', pattern: String.raw`\<foo`, text: 'x foo', magic: true },
  { id: 'word-end-boundary', pattern: String.raw`foo\>`, text: 'foo! xfoo', magic: true },
  { id: 'whole-word-boundaries', pattern: String.raw`\<foo\>`, text: 'xfoo foo!', magic: true },
  { id: 'very-magic-literal-dollar', pattern: String.raw`\v\$`, text: 'x$', magic: true },
  { id: 'very-nomagic-end-anchor', pattern: String.raw`\V\$`, text: 'x', magic: true },
  { id: 'mode-switch-to-very-magic', pattern: String.raw`\v(a|ab)+`, text: 'ab', magic: false },
  { id: 'mode-switch-to-very-nomagic-literal-dot', pattern: String.raw`\v(a|ab)+\V.`, text: 'ab.', magic: true },
];
const classText = 'aZ09 _-./:@!\t';
const builtinClassEscapes = ['d', 'D', 'w', 'W', 's', 'S', 'x', 'X', 'o', 'O', 'h', 'H', 'a', 'A', 'l', 'L', 'u', 'U', 'i', 'I', 'k', 'K', 'f', 'F', 'p', 'P'];
const posixClassNames = ['alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'xdigit', 'return', 'tab', 'escape', 'backspace', 'fname', 'ident', 'keyword'];
const classCases: readonly DialectCase[] = [
  ...builtinClassEscapes.map((escape) => ({ id: `builtin-class-${escape}`, pattern: `\\${escape}`, text: classText, magic: true })),
  ...posixClassNames.map((name) => ({ id: `posix-class-${name}`, pattern: `[[:${name}:]]`, text: classText, magic: true })),
  { id: 'posix-space-control-class', pattern: '[[:space:]]', text: ' \t\v\f\rA', magic: true },
  // No embedded-\n case here: `vim.fn.substitute()` matches a literal \n in a
  // flat Vimscript string via ordinary classes, but Xi's evaluator (like
  // real buffer/:s search) must not let an ordinary class cross a line
  // boundary; see tests/vim/pattern/parity-fixes.test.ts and the verified
  // `%s/[[:space:]]/X/g` buffer case (Pattern not found, confirming
  // no cross-line match) documented there.
  { id: 'posix-return-class', pattern: '[[:return:]]', text: '\rA', magic: true },
  { id: 'posix-escape-class', pattern: '[[:escape:]]', text: '\u001bA', magic: true },
  { id: 'posix-backspace-class', pattern: '[[:backspace:]]', text: '\bA', magic: true },
];
const allCases = [...cases, ...classCases];

const luaCases = allCases.map((fixture) =>
  `{ pattern=string.char(${luaBytes(`${fixture.magic ? '\\m' : '\\M'}${fixture.pattern}`)}), text=string.char(${luaBytes(fixture.text)}), magic=${fixture.magic ? 'true' : 'false'} }`,
).join(',');
const lua = `local cases={${luaCases}}; local result={}; for _,c in ipairs(cases) do vim.o.magic=c.magic; local text=vim.fn.substitute(c.text,c.pattern,'X','g'); local span=vim.fn.matchstrpos(c.text,c.pattern); table.insert(result,{text=text,span=span,magic=vim.o.magic}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
const fixture: OracleFixture = {
  id: 'PATT-T096-MAGIC-DIALECT-ORACLE-01',
  title: 'Compare Vim magic tables and quantifier priority with the pinned oracle',
  purpose: 'Direct matchstrpos oracle for mode-specific regular pattern syntax, escaped literals and precedence.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe dialect matrix', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
const oracleResult = await runOracleFixture(fixture, binaryPath);
const encoded = oracleResult.snapshots[0]?.lines[0];
assert(encoded !== undefined);
const expected = JSON.parse(encoded) as readonly { readonly text: string; readonly span: readonly [string, number, number]; readonly magic: boolean }[];
assert.equal(expected.length, allCases.length);

let matched = 0;
for (let index = 0; index < allCases.length; index += 1) {
  const test = allCases[index];
  const observation = expected[index];
  assert(test !== undefined && observation !== undefined);
  assert.equal(observation.magic, test.magic, `${test.id}: oracle magic option setup`);
  const result = substituteAll(
    compilePattern(test.pattern, { magic: test.magic }),
    createPatternTextSnapshot(1 as DocumentVersion, test.text),
    'X',
  );
  assert.equal(result.engine, 'nfa', `${test.id}: regular syntax must use the NFA`);
  assert.equal(result.text, observation.text, test.id);
  const first = result.matches[0];
  if (observation.span[1] < 0) {
    assert.equal(first, undefined, `${test.id}: oracle rejected a match`);
  } else {
    assert(first !== undefined, `${test.id}: oracle expected a match`);
    assert.deepEqual([first.start as number, first.end as number], [observation.span[1], observation.span[2]], `${test.id}: first match span differs`);
  }
  matched += 1;
}

console.log(`PASS ${fixture.id}: Neovim ${manifest.oracle.version} mode/quantifier/class cases=${matched}/${allCases.length}; binary=${manifest.oracle.binarySha256}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}
