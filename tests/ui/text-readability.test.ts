import assert from 'node:assert/strict';
import { RGBA, parseColor } from '@opentui/core/renderer';
import { readableTextColor } from '../../packages/ui/theme/readability';
import { contrastRatio } from '../../packages/ui/theme/motion-tokens';
assert.equal(readableTextColor('#7c7f93', '#ccd0da', '#4c4f69'), '#4c4f69', 'Latte menu text uses its readable editor foreground');
assert.equal(readableTextColor('#4c4f69', '#eff1f5', '#000000'), '#4c4f69', 'readable semantic colors remain intact');
const selected = readableTextColor('#4c4f69', '#bcc0cc', '#4c4f69');
assert.ok(contrastRatio(parseColor(selected), parseColor('#bcc0cc')) >= 4.5);
const indexed = RGBA.fromIndex(3);
assert.equal(readableTextColor(indexed, '#ffffff', '#000000'), indexed, 'terminal palette colors retain their intent');
console.log('UI readability fallback preserves readable colors and terminal intent');

const { createComponent, testRender } = await import('@opentui/solid');
const { RowsSurface } = await import('../../packages/ui/src/solid/panel');
const setup = await testRender(() => createComponent(RowsSurface, {
  read: { model: {}, subscribe: () => ({ dispose() {} }) }, isOpen: () => true,
  format: () => [], formatRows: () => [{ text: 'Indexed text', foreground: '\u0000xi-terminal-index:15' }],
  maxRows: 1, background: '#000000', foreground: '#ffffff', bounds: () => ({ left: 0, top: 0, width: 20, height: 1 }),
}), { width: 20, height: 1, bufferedOutput: 'memory' });
try {
  await setup.renderOnce();
  const span = setup.captureSpans().lines[0]?.spans.find(value => value.text.includes('Indexed'));
  assert.equal(span?.fg.intent, 'indexed', 'row foreground fallback is normalized at the renderer boundary');
  assert.equal(span?.fg.slot, 15);
} finally { setup.renderer.destroy(); }
