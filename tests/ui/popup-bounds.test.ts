import { strict as assert } from 'node:assert';
import { popupBoundsAtCursor } from '../../packages/ui/src/terminal';

// Popups (hover, completion, signature) anchor to the editor cursor and never cover the status
// row or run past the terminal edge; they flip sides when the preferred side has no room.
const below = popupBoundsAtCursor(120, 40, { x: 30, y: 10 }, { width: 50, height: 5 }, 'below');
assert.deepEqual(below, { width: 50, height: 5, left: 30, top: 11 }, 'POPUP-01 preferred below sits on the row under the cursor');

const flippedAbove = popupBoundsAtCursor(120, 40, { x: 30, y: 37 }, { width: 50, height: 5 }, 'below');
assert.deepEqual(flippedAbove, { width: 50, height: 5, left: 30, top: 32 }, 'POPUP-02 no room below flips above the cursor');

const above = popupBoundsAtCursor(120, 40, { x: 30, y: 10 }, { width: 50, height: 3 }, 'above');
assert.deepEqual(above, { width: 50, height: 3, left: 30, top: 7 }, 'POPUP-03 preferred above sits directly over the cursor');

const flippedBelow = popupBoundsAtCursor(120, 40, { x: 30, y: 1 }, { width: 50, height: 3 }, 'above');
assert.deepEqual(flippedBelow, { width: 50, height: 3, left: 30, top: 2 }, 'POPUP-04 no room above flips below');

const edge = popupBoundsAtCursor(120, 40, { x: 110, y: 10 }, { width: 50, height: 5 }, 'below');
assert.equal(edge.left, 70, 'POPUP-05 shifted left so the popup stays inside the terminal');

const noCursor = popupBoundsAtCursor(120, 40, undefined, { width: 50, height: 5 }, 'below');
assert.deepEqual(noCursor, { width: 50, height: 5, left: 35, top: 17 }, 'POPUP-06 without a cursor the popup is centered');

const tall = popupBoundsAtCursor(120, 10, { x: 0, y: 4 }, { width: 200, height: 30 }, 'below');
assert.ok(tall.width <= 118 && tall.top + tall.height <= 9, 'POPUP-07 oversized content is clamped inside the usable area');

console.log('popup-bounds passed cursor anchoring, side flipping, edge clamping and centered fallback fixtures');
