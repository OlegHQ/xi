import { strict as assert } from 'node:assert';
import { PanelScroll } from '../../packages/ui/src/panel-pointer';

// Selection reveal must not snap a wheel-scrolled panel back on the next paint.
const scroll = new PanelScroll();
scroll.follow('a', () => 0, 100, 10);
assert.equal(scroll.offset, 0);
scroll.scrollBy(40, 100, 10);
scroll.follow('a', () => 0, 100, 10); // repaint, same selection
assert.equal(scroll.offset, 40);
scroll.follow('b', () => 80, 100, 10); // selection moved below the viewport
assert.equal(scroll.offset, 71);
scroll.follow('c', () => 5, 100, 10); // selection moved above
assert.equal(scroll.offset, 5);
scroll.follow('c', () => 5, 8, 10); // list shrank: clamp
assert.equal(scroll.offset, 0);
console.log('panel-scroll-follow ok');
