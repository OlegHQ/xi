import { strict as assert } from 'node:assert';
import { formatGitDiffLines, type GitDiffReadModel } from '../../packages/ui/git/diff';
import { DiffViewController, type GitDiffLoadResult } from '../../packages/workbench/git/diff';
import type { Result } from '../../packages/contracts/src/index';
const model: GitDiffReadModel = { path: 'file.txt', leftLabel: 'INDEX', rightLabel: 'WORKTREE', layout: 'unified', lines: [{ kind: 'context', text: 'one' }, { kind: 'removed', text: 'TWO' }, { kind: 'added', text: 'two' }], hunks: [{ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, firstLineIndex: 0 }], selectedHunk: 0, scrollTop: 0, state: 'ready', message: undefined, generation: 1 };
const output = formatGitDiffLines(model, 80, 10).join('\n');
assert.match(output, /INDEX/u);
assert.match(output, /WORKTREE/u);
assert.match(output, /TWO/u);
assert.match(output, /two/u);
const scrolled = formatGitDiffLines({ ...model, scrollTop: 1 }, 80, 2).join('\n');
assert.doesNotMatch(scrolled, /one/u, 'controller-owned keyboard scrolling advances the rendered diff');
assert.match(scrolled, /TWO/u);

let finishLoad!: (result: Result<GitDiffLoadResult, { readonly message: string }>) => void;
const controller = new DiffViewController({
  host: { closeAllPanels: () => {}, notifySurfaceChange: () => {} } as never,
  workspaceRoot: '/workspace',
  marker: () => {},
  service: { load: () => new Promise(resolve => { finishLoad = resolve; }) },
});
const states: string[] = [];
controller.subscribe(() => { states.push(controller.readModel().state); });
const opened = controller.open('file.txt', 'worktree');
assert.equal(controller.readModel().state, 'loading');
finishLoad({ ok: true, value: { kind: 'ready', leftLabel: 'INDEX', rightLabel: 'WORKTREE', diff: { lines: [{ kind: 'added', newLine: 1, text: 'loaded\n' }], hunks: [{ index: 0, oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, firstLineIndex: 0 }] } } });
await opened;
assert.equal(controller.readModel().state, 'ready', 'a completed async load replaces the cached loading model');
assert.equal(controller.readModel().lines[0]?.text, 'loaded\n');
assert.equal(states.at(-1), 'ready', 'subscribers observe installed diff data, not the preceding loading snapshot');
console.log('T-git-diff shared formatter passed unified and bounded output checks');
