import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';
import { inlineDiagnosticLines } from '../../packages/ui/problems/inline';
import type { Problem } from '../../packages/ui/problems/index';

const created = TextFileDocument.create('diagnostic-doc' as never, 'const x: string = 2;\nconst next = 3;\n', ['lf', 'lf'], 'lf');
assert.ok(created.ok);
const document = created.value;
const session = new WorkbenchSession({ workspaceId: 'diagnostic-test' });
const opened = session.openBuffer(document, { path: '/test.ts' });
assert.ok(opened.ok);
const problem: Problem = { id: 'error', uri: 'file:///test.ts', serverId: 'ts', generation: Number(document.version), documentVersion: Number(document.version),
  range: { startLine: 0, endLine: 0, startUtf16: 6, endUtf16: 7 }, severity: 1, code: 2322, source: 'ts', message: "Type 'number' is not assignable to type 'string'." };
let problems: readonly Problem[] = [problem, { ...problem, id: 'hint', severity: 4, code: 6133, message: "'x' is declared but its value is never read." }];
const setup = await createTestRenderer({ width: 100, height: 25, bufferedOutput: 'memory' });
const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: session, editorDiagnostics: () => problems });
setup.renderer.root.add(viewport);
try {
  viewport.syncAnchors();
  await setup.renderOnce();
  const chars = setup.captureCharFrame();
  assert.match(chars, /2322: Type 'number'/u);
  assert.match(chars, /6133: 'x' is declared/u);
  assert.ok(chars.indexOf('2322:') < chars.indexOf('const next'), 'diagnostics insert rows; never overwrite source');
  const frame = viewport.lastFrame?.frame;
  assert.ok(frame);
  assert.equal(frame.rows[1]?.kind, 'diff-filler');
  assert.equal(frame.rows[1]?.cells[0]?.target?.kind, 'diff-filler', 'diagnostic cells cannot address editable text');
  assert.equal(document.snapshot().lengthUtf16, 'const x: string = 2;\nconst next = 3;\n'.length, 'virtual rows never enter the document');
  problems = [];
  viewport.refresh();
  await setup.renderOnce();
  assert.doesNotMatch(setup.captureCharFrame(), /2322|6133/u, 'cleared diagnostics erase all old rows');
  assert.equal(viewport.lastFrame?.frame?.rows[1]?.lineIndex, 1);
  const stale = inlineDiagnosticLines(document.snapshot(), [{ ...problem, documentVersion: 999 }], 0, 60, 10, 4);
  assert.equal(stale.length, 0, 'stale positions cannot decorate new text');
  assert.ok(inlineDiagnosticLines(document.snapshot(), [{ ...problem, documentVersion: undefined, generation: 42 }], 0, 60, 10, 4).length > 0, 'task generations are not document versions');
  const hostile = inlineDiagnosticLines(document.snapshot(), [{ ...problem, message: '\x1b[31m你好 😀\n'.repeat(10000) }], 0, 30, 8, 4);
  assert.ok(hostile.length <= 8);
  assert.ok(hostile.every(line => !line.text.includes('\x1b') && !line.text.includes('\n')));
} finally { setup.renderer.destroy(); session.dispose(); }
console.log('inline diagnostics: visible messages, wrapping, noneditable hit maps, clearing, stale versions and bounded hostile payload pass');
