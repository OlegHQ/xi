import assert from 'node:assert/strict';
import { NodeProcessPort } from '../../packages/platform/src/entrypoints/launch';
import {
  FormatterPipeline,
  createExternalFormatter,
  createLspFormatter,
  type FormatDocument,
  type FormatterSpec,
} from '../../packages/services/formatting/index';

const document: FormatDocument = { documentId: 'doc', version: 1, path: '/tmp/a.ts', text: ' const x=1; ' };
const trim: FormatterSpec = { id: 'trim', async run(input) { return { ok: true, value: input.text.trim() }; } };
const spaces: FormatterSpec = { id: 'spaces', async run(input) { return { ok: true, value: input.text.replace(/\s*=\s*/gu, ' = ') }; } };
const pipeline = new FormatterPipeline([trim, spaces]);
const stable = await pipeline.formatTwiceStable(document, () => 1);
assert.equal(stable.ok, true, 'T055-STABLE-01 formatter chain runs twice with stable output');
if (stable.ok) assert.equal(stable.value.text, 'const x = 1;');
let version = 1; const stale = await pipeline.format(document, () => { version += 1; return version; }); assert.equal(stale.ok, false, 'T055-STALE-01 typing during formatting preserves document');
const failing = new FormatterPipeline([{ id: 'fail', async run() { return { ok: false, error: { kind: 'failed', message: 'tool failed' } }; } }]); const failure = await failing.format(document, () => 1); assert.equal(failure.ok, false, 'T055-FAIL-01 formatter error remains explicit');

const rangeFormatter = createLspFormatter('lsp-range', {
  async format(input) {
    assert.deepEqual(input.range, { start: 1, end: 6 }, 'T055-RANGE-01 passes the requested UTF-16 range to the LSP provider');
    return { ok: true, value: [{ start: 1, end: 6, text: 'const' }] };
  },
});
const ranged = await new FormatterPipeline([rangeFormatter]).format({ ...document, text: ' x = 1; ', range: { start: 1, end: 6 } }, () => 1);
assert.equal(ranged.ok && ranged.value.text, ' const; ', 'T055-RANGE-02 applies validated LSP edits in document order');

const environment = Object.freeze(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
const processFormatter = createExternalFormatter({
  id: 'bun-fixture',
  command: process.execPath,
  args: ['-e', 'const text = await new Response(Bun.stdin).text(); process.stdout.write(text.replace(/\\s*=\\s*/g, " = "));'],
  process: new NodeProcessPort(),
  cwd: process.cwd(),
  env: environment,
  timeoutMilliseconds: 2_000,
});
const externalPipeline = new FormatterPipeline([processFormatter]);
const external = await externalPipeline.formatTwiceStable({ ...document, text: 'const x=1;' }, () => 1);
assert.equal(external.ok && external.value.text, 'const x = 1;', 'T055-EXTERNAL-01 runs a real argv-backed formatter twice with stable output');

const secondStageFailure = createExternalFormatter({
  id: 'second-stage-failure',
  command: process.execPath,
  args: ['-e', 'process.stderr.write("second formatter failed"); process.exit(7);'],
  process: new NodeProcessPort(),
  cwd: process.cwd(),
  env: environment,
  timeoutMilliseconds: 2_000,
});
const chainedFailure = await new FormatterPipeline([processFormatter, secondStageFailure]).format({ ...document, text: 'const x=1;' }, () => 1);
assert.equal(chainedFailure.ok, false, 'T055-FAIL-02 a second formatter failure aborts the ordered chain');

const timeoutFormatter = createExternalFormatter({
  id: 'timeout-fixture',
  command: process.execPath,
  args: ['-e', 'await Bun.sleep(200); process.stdout.write("late");'],
  process: new NodeProcessPort(),
  cwd: process.cwd(),
  env: environment,
  timeoutMilliseconds: 30,
});
const timedOut = await timeoutFormatter.run(document);
assert.equal(timedOut.ok, false, 'T055-TIMEOUT-01 formatter timeout is reported before output can apply');
if (!timedOut.ok) assert.equal(timedOut.error.kind, 'timeout', 'T055-TIMEOUT-02 timeout is distinguished from a formatter exit failure');

pipeline.dispose(); failing.dispose(); externalPipeline.dispose();
console.log('T055 formatting passed stable chains, LSP ranges, real external argv execution, timeout and failure preservation');
