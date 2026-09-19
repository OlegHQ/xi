import { strict as assert } from 'node:assert';
import { formatGitLines, type GitPanelReadModel } from '../../packages/ui/git/index';

const model: GitPanelReadModel = {
  contractVersion: 1, generation: 1, branch: 'main', state: 'ready', message: undefined, selectedId: 'git:alpha.ts',
  sections: [
    { id: 'staged', label: 'Staged Changes', count: 1, collapsed: false, entries: [{ id: 'git:alpha.ts', path: 'alpha.ts', state: 'modified', letter: 'M' }] },
    { id: 'changes', label: 'Changes', count: 1, collapsed: false, entries: [{ id: 'git:beta.ts', path: 'beta.ts', state: 'modified', letter: 'M' }] },
    { id: 'untracked', label: 'Untracked', count: 1, collapsed: false, entries: [{ id: 'git:gamma.ts', path: 'gamma.ts', state: 'untracked', letter: 'U' }] },
    { id: 'conflicts', label: 'Merge Conflicts', count: 0, collapsed: false, entries: [] },
  ],
};
const rows = formatGitLines(model, 40, 14).join('\n');
assert.match(rows, /main/u);
assert.match(rows, /Staged Changes/u);
assert.match(rows, /alpha\.ts/u);
assert.match(rows, /Enter open/u);
assert.match(formatGitLines({ ...model, selectedId: 'git:beta.ts' }, 40, 14).join('\n'), /▶/u);
assert.doesNotMatch(formatGitLines({ ...model, sections: model.sections.map(section => section.id === 'staged' ? { ...section, collapsed: true } : section) }, 40, 14).join('\n'), /alpha\.ts/u);
console.log('T-GITPANEL shared Git formatter passed section, selection and collapse checks');
