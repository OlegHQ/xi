import assert from 'node:assert/strict';
import { checkStaticRules, type SourceUnit } from '../../tools/check-import-graph';

// H2-7: tools/check-import-graph.ts's checkStaticRules() is wired into checkImportGraph(),
// which `bun run check:public-boundary` already runs -- this test exercises the four rules
// directly against synthetic fixtures so a regression is caught even if the real repository
// happens to have zero violations of a given rule at some point in time.

function unit(path: string, text: string): SourceUnit {
  return { path, text };
}

function has(failures: readonly string[], code: string): boolean {
  return failures.some((failure) => failure.includes(code));
}

// (a) services read-only document surface.
assert.ok(
  has(checkStaticRules([unit('packages/services/files/x.ts', "import { openTextDocument } from '../../document/src/index.ts';\n")]), 'ARCH-SERVICES-DOCUMENT-SURFACE-01'),
  'H2-7-01 a value import of openTextDocument from packages/services/** is rejected',
);
assert.ok(
  has(checkStaticRules([unit('packages/services/files/x.ts', "import { applyBatch } from '../../document/src/index.ts';\n")]), 'ARCH-SERVICES-DOCUMENT-SURFACE-01'),
  'H2-7-02 a value import of applyBatch from packages/services/** is rejected',
);
assert.ok(
  !has(checkStaticRules([unit('packages/services/files/x.ts', "import type { TextFileDocument } from '../../document/src/index.ts';\n")]), 'ARCH-SERVICES-DOCUMENT-SURFACE-01'),
  'H2-7-03 a type-only import of TextFileDocument is allowed',
);
assert.ok(
  !has(checkStaticRules([unit('packages/services/files/x.ts', "import { readTextDocument } from '../../document/src/index.ts';\n")]), 'ARCH-SERVICES-DOCUMENT-SURFACE-01'),
  'H2-7-04 an unrelated named import never trips the rule',
);

// (b) apps/xi function length.
const shortFunction = unit('apps/xi/src/x.ts', 'function ok() {\n  return 1;\n}\n');
assert.ok(!has(checkStaticRules([shortFunction]), 'ARCH-APP-FUNCTION-LENGTH-01'), 'H2-7-05 a short apps/xi function is allowed');
const longFunction = unit('apps/xi/src/x.ts', `function tooLong() {\n${'  const line = 1;\n'.repeat(200)}}\n`);
assert.ok(has(checkStaticRules([longFunction]), 'ARCH-APP-FUNCTION-LENGTH-01'), 'H2-7-06 a 200-line apps/xi function body is rejected');
const longTypedFunction = unit('apps/xi/src/x.ts', `export async function tooLong(): Promise<void> {\n${'  const line = 1;\n'.repeat(200)}}\n`);
assert.ok(has(checkStaticRules([longTypedFunction]), 'ARCH-APP-FUNCTION-LENGTH-01'), 'H2-7-07 an over-length function is still caught through a typed return annotation (: Promise<void>)');

// (c) packages/ui renderSelf must not call a workbench setter.
assert.ok(
  has(checkStaticRules([unit('packages/ui/x.ts', 'class X { renderSelf() { this.workbench.setActiveView(1); } }\n')]), 'ARCH-UI-RENDER-READONLY-01'),
  'H2-7-08 renderSelf calling a *Set-shaped setter is rejected',
);
assert.ok(
  !has(checkStaticRules([unit('packages/ui/x.ts', 'class X { renderSelf() { const seen = new Set(); seen.add(1); return seen.has(1); } }\n')]), 'ARCH-UI-RENDER-READONLY-01'),
  'H2-7-09 a plain Set/.has()/.add() in renderSelf is not mistaken for a workbench setter',
);
assert.ok(
  !has(checkStaticRules([unit('packages/ui/x.ts', 'class X { otherMethod() { this.workbench.setActiveView(1); } }\n')]), 'ARCH-UI-RENDER-READONLY-01'),
  'H2-7-10 a setter call outside renderSelf is out of scope for this rule',
);

// (d) Intl.Segmenter/GRAPHEME_SEGMENTER must be module-level.
assert.ok(
  has(checkStaticRules([unit('packages/vim/x.ts', 'function f() { return new Intl.Segmenter("en", { granularity: "grapheme" }); }\n')]), 'ARCH-MODULE-LEVEL-SEGMENTER-01'),
  'H2-7-11 new Intl.Segmenter(...) inside a function body is rejected',
);
assert.ok(
  has(checkStaticRules([unit('packages/vim/x.ts', 'function f() { return new GRAPHEME_SEGMENTER(); }\n')]), 'ARCH-MODULE-LEVEL-SEGMENTER-01'),
  'H2-7-12 new GRAPHEME_SEGMENTER() inside a function body is rejected',
);
assert.ok(
  !has(checkStaticRules([unit('packages/vim/x.ts', 'const s = new Intl.Segmenter("en", { granularity: "grapheme" });\nfunction f() { return s; }\n')]), 'ARCH-MODULE-LEVEL-SEGMENTER-01'),
  'H2-7-13 a module-level Intl.Segmenter const is allowed',
);
assert.ok(
  !has(checkStaticRules([unit('tools/x.ts', 'function f() { return new Intl.Segmenter("en", { granularity: "grapheme" }); }\n')]), 'ARCH-MODULE-LEVEL-SEGMENTER-01'),
  'H2-7-14 the rule only scans packages/** (non-packages paths are out of scope)',
);

console.log('H2-7 static rules (services document surface, app function length, ui renderSelf read-only, module-level segmenter) fire on synthetic violations and accept clean equivalents');
