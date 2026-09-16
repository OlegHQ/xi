import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  compilePattern,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  type PatternCharacterClassContext,
} from '../../../packages/vim/pattern/index';
import type { DocumentVersion } from '../../../packages/primitives/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

interface ClassOracleCase {
  readonly id: string;
  readonly pattern: string;
  readonly text: string;
  readonly optionName?: 'iskeyword' | 'isident' | 'isfname' | 'isprint';
  readonly optionValue?: string;
}

const cases: readonly ClassOracleCase[] = [
  { id: 'builtin-alpha-greek', pattern: String.raw`\a`, text: 'λ!' },
  { id: 'builtin-alpha-cjk', pattern: String.raw`\a`, text: '中!' },
  { id: 'builtin-alpha-emoji', pattern: String.raw`\a`, text: '😀!' },
  { id: 'builtin-lower-greek', pattern: String.raw`\l`, text: 'λ!' },
  { id: 'builtin-upper-greek', pattern: String.raw`\u`, text: 'Ω!' },
  { id: 'builtin-lower-ascii-only', pattern: String.raw`\l`, text: 'λa' },
  { id: 'builtin-upper-ascii-only', pattern: String.raw`\u`, text: 'ΩA' },
  { id: 'posix-alpha-greek', pattern: '[[:alpha:]]', text: 'λ!' },
  { id: 'posix-alpha-latin1', pattern: '[[:alpha:]]', text: 'é!' },
  { id: 'posix-lower-greek', pattern: '[[:lower:]]', text: 'λ!' },
  { id: 'posix-lower-latin1', pattern: '[[:lower:]]', text: 'é!' },
  { id: 'posix-upper-greek', pattern: '[[:upper:]]', text: 'Ω!' },
  { id: 'posix-upper-latin1', pattern: '[[:upper:]]', text: 'É!' },
  { id: 'posix-alnum-greek', pattern: '[[:alnum:]]', text: 'λ!' },
  { id: 'keyword-default-greek', pattern: String.raw`\k`, text: 'λ!' },
  { id: 'keyword-default-emoji', pattern: String.raw`\k`, text: '😀!' },
  { id: 'keyword-default-supplementary-number', pattern: String.raw`\k`, text: '𝟠!' },
  { id: 'keyword-default-arabic-number', pattern: String.raw`\k`, text: '١!' },
  { id: 'keyword-default-letter-number', pattern: String.raw`\k`, text: 'Ⅷ!' },
  { id: 'keyword-custom-hyphen-excludes-emoji', pattern: String.raw`\k`, text: '😀-', optionName: 'iskeyword', optionValue: '45' },
  { id: 'keyword-custom-hyphen-greek', pattern: String.raw`\k`, text: 'λ-', optionName: 'iskeyword', optionValue: '45' },
  { id: 'keyword-custom-hyphen-latin1', pattern: String.raw`\k`, text: 'é-', optionName: 'iskeyword', optionValue: '45' },
  { id: 'keyword-at-emoji', pattern: String.raw`\k`, text: '😀!', optionName: 'iskeyword', optionValue: '@' },
  { id: 'keyword-at-greek', pattern: String.raw`\k`, text: 'λ!', optionName: 'iskeyword', optionValue: '@' },
  { id: 'identifier-default-greek', pattern: String.raw`\i`, text: 'λ!' },
  { id: 'identifier-default-latin1', pattern: String.raw`\i`, text: 'é!' },
  { id: 'identifier-default-ascii', pattern: String.raw`\i`, text: 'a!' },
  { id: 'identifier-at-greek', pattern: String.raw`\i`, text: 'λ!', optionName: 'isident', optionValue: '@' },
  { id: 'identifier-at-emoji', pattern: String.raw`\i`, text: '😀!', optionName: 'isident', optionValue: '@' },
  { id: 'filename-default-greek', pattern: String.raw`\f`, text: 'λ!' },
  { id: 'filename-default-latin1', pattern: String.raw`\f`, text: 'é!' },
  { id: 'filename-at-greek', pattern: String.raw`\f`, text: 'λ!', optionName: 'isfname', optionValue: '@' },
  { id: 'filename-at-emoji', pattern: String.raw`\f`, text: '😀!', optionName: 'isfname', optionValue: '@' },
  { id: 'printable-default-emoji', pattern: String.raw`\p`, text: '😀!' },
  { id: 'printable-default-latin1', pattern: String.raw`\p`, text: 'é!' },
  { id: 'printable-default-c1-control', pattern: String.raw`\p`, text: '\u0085!' },
  { id: 'printable-custom-ascii-excludes-a', pattern: String.raw`\p`, text: 'aA', optionName: 'isprint', optionValue: '^97' },
  { id: 'printable-at-emoji', pattern: String.raw`\p`, text: '😀!', optionName: 'isprint', optionValue: '@' },
  { id: 'posix-ident-default-greek', pattern: '[[:ident:]]', text: 'λ!' },
  { id: 'posix-keyword-default-greek', pattern: '[[:keyword:]]', text: 'λ!' },
  { id: 'posix-fname-default-greek', pattern: '[[:fname:]]', text: 'λ!' },
  { id: 'keyword-custom-hyphen', pattern: String.raw`\k`, text: '-x', optionName: 'iskeyword', optionValue: '45' },
  { id: 'posix-keyword-custom-hyphen', pattern: '[[:keyword:]]', text: '-x', optionName: 'iskeyword', optionValue: '45' },
  { id: 'keyword-custom-last-rule-excludes-a', pattern: String.raw`\k`, text: 'aA!', optionName: 'iskeyword', optionValue: '@,^97' },
  { id: 'keyword-custom-unicode-range', pattern: String.raw`\k`, text: 'λ!', optionName: 'iskeyword', optionValue: 'α-ω' },
  { id: 'identifier-custom-hyphen', pattern: String.raw`\i`, text: '-x', optionName: 'isident', optionValue: '45' },
  { id: 'identifier-custom-hyphen-greek', pattern: String.raw`\i`, text: 'λ-', optionName: 'isident', optionValue: '45' },
  { id: 'posix-ident-custom-hyphen', pattern: '[[:ident:]]', text: '-x', optionName: 'isident', optionValue: '45' },
  { id: 'identifier-no-digit-custom', pattern: String.raw`\I`, text: '7-', optionName: 'isident', optionValue: '48-57,45' },
  { id: 'filename-custom-hyphen', pattern: String.raw`\f`, text: '-x', optionName: 'isfname', optionValue: '45' },
  { id: 'filename-custom-hyphen-greek', pattern: String.raw`\f`, text: 'λ-', optionName: 'isfname', optionValue: '45' },
  { id: 'filename-custom-hyphen-latin1', pattern: String.raw`\f`, text: 'é-', optionName: 'isfname', optionValue: '45' },
  { id: 'posix-fname-custom-hyphen', pattern: '[[:fname:]]', text: '-x', optionName: 'isfname', optionValue: '45' },
  { id: 'filename-no-digit-custom', pattern: String.raw`\F`, text: '7-', optionName: 'isfname', optionValue: '48-57,45' },
  { id: 'printable-custom-ascii', pattern: String.raw`\p`, text: 'λA', optionName: 'isprint', optionValue: '32-126' },
  { id: 'printable-custom-hyphen', pattern: String.raw`\p`, text: 'a-', optionName: 'isprint', optionValue: '45' },
  { id: 'printable-custom-hyphen-latin1', pattern: String.raw`\p`, text: 'é!', optionName: 'isprint', optionValue: '45' },
  { id: 'printable-custom-excludes-latin1-range', pattern: String.raw`\p`, text: 'é!', optionName: 'isprint', optionValue: '^192-255' },
  { id: 'printable-custom-ascii-c1-control', pattern: String.raw`\p`, text: '\u0085!', optionName: 'isprint', optionValue: '45' },
  { id: 'printable-custom-c1-value', pattern: String.raw`\p`, text: '\u0085!', optionName: 'isprint', optionValue: '133' },
  { id: 'posix-print-custom-ascii', pattern: '[[:print:]]', text: 'λA', optionName: 'isprint', optionValue: '32-126' },
  { id: 'printable-no-digit-custom', pattern: String.raw`\P`, text: '7-', optionName: 'isprint', optionValue: '48-57,45' },
  { id: 'printable-custom-nonascii-range', pattern: String.raw`\p`, text: 'λ!', optionName: 'isprint', optionValue: '161-255' },
  { id: 'keyword-custom-excludes-unicode-letter', pattern: String.raw`\k`, text: 'λΩ!', optionName: 'iskeyword', optionValue: '@,^λ' },
];

const luaCases = cases.map((test) => {
  const optionName = test.optionName === undefined ? 'nil' : luaString(test.optionName);
  const optionValue = test.optionValue === undefined ? 'nil' : `string.char(${luaBytes(test.optionValue)})`;
  return `{id=${luaString(test.id)},pattern=string.char(${luaBytes(test.pattern)}),text=string.char(${luaBytes(test.text)}),option=${optionName},value=${optionValue}}`;
}).join(',');
const lua = `local names={'iskeyword','isident','isfname','isprint'}; local defaults={}; for _,name in ipairs(names) do defaults[name]=vim.o[name] end; local cases={${luaCases}}; local observations={}; for _,c in ipairs(cases) do for _,name in ipairs(names) do vim.o[name]=defaults[name] end; local optionError=nil; if c.option~=nil then local ok,error=pcall(function() vim.o[c.option]=c.value end); if not ok then optionError=tostring(error) end end; local span=vim.fn.matchstrpos(c.text,c.pattern); local optionValue=nil; local bufferOptionValue=nil; if c.option~=nil then optionValue=vim.o[c.option]; local ok,value=pcall(function() return vim.bo[c.option] end); if ok then bufferOptionValue=value end end; observations[#observations+1]={id=c.id,text=span[1],start=span[2],finish=span[3],optionError=optionError,optionValue=optionValue,bufferOptionValue=bufferOptionValue} end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode({defaults=defaults,observations=observations})})`;
const fixture: OracleFixture = {
  id: 'T026-VP05-CHARACTER-CLASS-CONTEXT',
  title: 'Pinned Vim Unicode and buffer-option character classes',
  purpose: 'Observe Unicode built-in/POSIX class behavior and option-driven iskeyword, isident, isfname and isprint matches.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe-character-class-matrix', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
const result = await runOracleFixture(fixture, binaryPath);
const encoded = result.snapshots[0]?.lines[0];
assert(encoded !== undefined, 'character-class oracle matrix emitted observations');
const measured = JSON.parse(encoded) as {
  readonly defaults: Readonly<Record<'iskeyword' | 'isident' | 'isfname' | 'isprint', string>>;
  readonly observations: readonly {
    readonly id: string;
    readonly text: string;
    readonly start: number;
    readonly finish: number;
    readonly optionError?: string;
    readonly optionValue?: string;
  }[];
};
assert.equal(measured.observations.length, cases.length);

const version = 26_026 as DocumentVersion;
const observations = new Map(measured.observations.map((observation) => [observation.id, observation]));
const compared: { readonly id: string; readonly expected: readonly [number, number] | null; readonly actual: readonly [number, number] | null }[] = [];
let rejectedOptionCount = 0;
for (const test of cases) {
  const oracle = observations.get(test.id);
  assert(oracle !== undefined, `${test.id}: pinned observation exists`);
  const options = test.optionName === undefined ? {} : {
    characterClassContext: classContextFor(test, measured.defaults, version),
  };
  if (oracle.optionError !== undefined) {
    assert(test.optionName !== undefined, `${test.id}: oracle rejected a specified option`);
    assert.throws(() => compilePattern(test.pattern, options), (error: unknown) =>
      error instanceof PatternEvaluationError && error.code === 'invalid-pattern'
        && error.source?.start === 0 && error.source.end === test.pattern.length,
      `${test.id}: Xi rejects a character-option spelling that pinned Vim rejects`);
    rejectedOptionCount += 1;
    continue;
  }

  const actual = findAllMatches(
    compilePattern(test.pattern, options),
    createPatternTextSnapshot(version, test.text),
  ).matches[0];
  if (oracle.start < 0) {
    assert.equal(actual, undefined, `${test.id}: pinned Vim has no match`);
    compared.push({ id: test.id, expected: null, actual: null });
    continue;
  }
  assert(actual !== undefined, `${test.id}: Xi finds pinned Vim's match`);
  const expected = [utf16AtByte(test.text, oracle.start), utf16AtByte(test.text, oracle.finish)] as const;
  const actualSpan = [actual.start as number, actual.end as number] as const;
  assert.deepEqual(actualSpan, expected, `${test.id}: UTF-8 oracle span and Xi UTF-16 span agree`);
  compared.push({ id: test.id, expected, actual: actualSpan });
}

const stale = compilePattern(String.raw`\k`, {
  characterClassContext: classContextFor(cases.find((test) => test.id === 'keyword-custom-hyphen')!, measured.defaults, 26_025 as DocumentVersion),
});
assert.throws(() => findAllMatches(stale, createPatternTextSnapshot(version, 'word')), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'stale-position'
    && error.source?.start === 0 && error.source.end === 2,
  'T026-VP05-STALE-CLASS-CONTEXT: stale option context fails with source span');

const artifact = resolve(process.cwd(), '.artifacts/patterns/T026-vp05-character-classes.json');
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, `${JSON.stringify({
  schemaVersion: 1,
  fixtureId: fixture.id,
  oracle: { version: manifest.oracle.version, binarySha256: manifest.oracle.binarySha256 },
  defaults: measured.defaults,
  cases: compared,
  rejectedOptionCount,
  staleClassContext: { code: 'stale-position', source: { start: 0, end: 2 } },
}, null, 2)}\n`, 'utf8');
console.log(`PASS ${fixture.id}: pinned Vim ${manifest.oracle.version}; matched=${compared.length}/${cases.length}; Vim-rejected invalid options=${rejectedOptionCount}; stale-context passed; artifact=${artifact}`);

function luaString(value: string): string {
  return `\"${[...Buffer.from(value, 'utf8')].map((byte) => `\\${byte.toString().padStart(3, '0')}`).join('')}\"`;
}

function luaBytes(value: string): string {
  const bytes = [...Buffer.from(value, 'utf8')];
  return bytes.length === 0 ? '' : bytes.join(',');
}

function classContextFor(
  test: ClassOracleCase,
  defaults: Readonly<Record<'iskeyword' | 'isident' | 'isfname' | 'isprint', string>>,
  contextVersion: DocumentVersion,
): PatternCharacterClassContext {
  const base = {
    version: contextVersion,
    isKeyword: defaults.iskeyword,
    isIdent: defaults.isident,
    isFilename: defaults.isfname,
    isPrintable: defaults.isprint,
  };
  switch (test.optionName) {
    case 'iskeyword': return { ...base, isKeyword: test.optionValue ?? '' };
    case 'isident': return { ...base, isIdent: test.optionValue ?? '' };
    case 'isfname': return { ...base, isFilename: test.optionValue ?? '' };
    case 'isprint': return { ...base, isPrintable: test.optionValue ?? '' };
    case undefined: return base;
    default: return unreachable(test.optionName);
  }
}

function utf16AtByte(value: string, target: number): number {
  let byteOffset = 0;
  let utf16Offset = 0;
  if (target === 0) return 0;
  for (const scalar of value) {
    byteOffset += Buffer.byteLength(scalar, 'utf8');
    utf16Offset += scalar.length;
    if (byteOffset === target) return utf16Offset;
    if (byteOffset > target) throw new Error(`oracle-byte-offset-inside-scalar: ${target}`);
  }
  if (byteOffset === target) return utf16Offset;
  throw new Error(`oracle-byte-offset-out-of-range: ${target}/${byteOffset}`);
}

function unreachable(value: never): never {
  throw new Error(`unreachable-option-name: ${String(value)}`);
}
