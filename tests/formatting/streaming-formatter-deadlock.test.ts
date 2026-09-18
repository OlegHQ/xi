import assert from 'node:assert/strict';
import { NodeProcessPort } from '../../packages/platform/src/entrypoints/launch';
import { FormatterPipeline, createExternalFormatter } from '../../packages/services/formatting/index';

// A streaming formatter echoes each stdin chunk straight back to stdout without buffering
// its whole input. With ~1 MiB of input the OS pipe buffers fill in both directions, so a
// formatter driver that writes all of stdin before reading stdout deadlocks (F item 19).
const environment = Object.freeze(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
const streaming = createExternalFormatter({
  id: 'streaming-echo',
  command: process.execPath,
  args: ['-e', 'for await (const chunk of Bun.stdin.stream()) process.stdout.write(chunk);'],
  process: new NodeProcessPort(),
  cwd: process.cwd(),
  env: environment,
  timeoutMilliseconds: 10_000,
});
const text = 'x = 1;\n'.repeat(160_000);
const started = performance.now();
const result = await new FormatterPipeline([streaming]).format({ documentId: 'doc', version: 1, path: '/tmp/big.ts', text }, () => 1);
assert.equal(result.ok, true, `STREAMING-FORMATTER-01 streaming formatter completes without deadlock: ${JSON.stringify(result)}`);
if (result.ok) assert.equal(result.value.text, text, 'STREAMING-FORMATTER-02 output round-trips');
assert.ok(performance.now() - started < 9_000, 'STREAMING-FORMATTER-03 finished before the timeout');
console.log('streaming formatter deadlock regression passed');
