import assert from 'node:assert/strict';
import { GitHistoryController } from '../../packages/services/git/index';

const history = new GitHistoryController(); history.publishHistory([{ id: 'c1', commit: 'abc', subject: 'first', author: 'A', timestamp: 1 }]);
const opened = history.openReadOnly('c1'); assert.equal(opened.ok, true, 'T059-HISTORY-01 history opens read-only entry');
history.setConflict({ path: 'a.ts', base: 'base', ours: 'ours', theirs: 'theirs', result: 'markers', unresolved: true });
assert.equal(history.markResolved('a.ts', true).ok, false, 'T059-CONFLICT-01 marker text cannot certify resolution'); assert.equal(history.markResolved('a.ts', false).ok, true, 'T059-CONFLICT-02 Git unmerged state cleared before resolve');
history.dispose();
console.log('T059 Git history/merge passed read-only history navigation and explicit unmerged-state resolution checks');
