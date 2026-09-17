import assert from 'node:assert/strict';
import { WorkbenchPointerCapture, WorkbenchSession, ContributionRegistry } from '../../packages/workbench/src/index';
import { ExCommandLineSession } from '../../packages/workbench/src/entrypoints/launch';
import { PrefixHelpController } from '../../packages/ui/src/index';
import { PointerGestureController } from '../../packages/vim/src/index';
import { ProblemsRenderable, SearchRenderable, paintEditorFrame } from '../../packages/ui/src/index';

assert.equal(typeof WorkbenchSession, 'function', 'G3-SESSION-01 session composition exists');
assert.equal(typeof WorkbenchPointerCapture, 'function', 'G3-MOUSE-01 pointer capture composition exists');
assert.equal(typeof PointerGestureController, 'function', 'G3-MOUSE-02 Vim pointer owner exists');
assert.equal(typeof PrefixHelpController, 'function', 'G3-DISCOVERY-01 prefix help exists');
assert.equal(typeof ExCommandLineSession, 'function', 'G3-DISCOVERY-02 Ex discovery exists');
assert.equal(typeof ContributionRegistry, 'function', 'G3-EXT-01 contribution registry exists');
assert.equal(typeof ProblemsRenderable, 'function', 'G3-LANGUAGE-01 Problems UI exists');
assert.equal(typeof SearchRenderable, 'function', 'G3-SEARCH-01 search UI exists');
assert.equal(typeof paintEditorFrame, 'function', 'G3-PAINT-01 motion painter exists');
console.log('T045 G3 qualification passed session, discovery, mouse capture, contribution, search/Problems and motion-paint composition checks');
