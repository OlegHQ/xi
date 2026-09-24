import assert from 'node:assert/strict';
import { DARK_WORKBENCH_THEME } from '../../packages/ui/theme/workbench-themes';
import { pickerRows, prefixHelpRows } from '../../packages/ui/src/solid/workbench';
import { getPrefixHelpBounds } from '../../packages/ui/src/solid/layout';
import { measurePrefixHelp, prefixHelpEntries, prefixHelpTitle } from '../../packages/ui/help/index';
import type { PrefixHelpReadModel } from '../../packages/workbench/src/index';
import type { PickerReadModel } from '../../packages/ui/picker/index';

const theme = DARK_WORKBENCH_THEME;
const prefix: PrefixHelpReadModel = {
  registryGeneration: 1,
  focusGeneration: 1,
  configGeneration: 1,
  targetId: 'editor',
  pendingKeys: ['<Space>'],
  compactHint: 'm: Add next occurrence',
  hints: [
    { kind: 'mapping', keys: ['m'], keyLabel: 'm', sequence: ['<Space>', 'm'], title: 'Add next occurrence', description: 'Select next matching word', commandId: 'selection.add-next', aliases: [], available: true, disabledReason: undefined },
    { kind: 'mapping', keys: ['G'], keyLabel: 'G', sequence: ['<Space>', 'G'], title: 'Open source control', description: 'Show changed files', commandId: 'git.open', aliases: [], available: false, disabledReason: 'Git is unavailable' },
    { kind: 'mapping', keys: ['v', 'f'], keyLabel: 'v f', sequence: ['<Space>', 'v', 'f'], title: 'Focus files', description: 'Focus files', commandId: 'panel.files.focus', aliases: [], available: true, disabledReason: undefined },
    { kind: 'mapping', keys: ['v', 'd'], keyLabel: 'v d', sequence: ['<Space>', 'v', 'd'], title: 'Git diff', description: 'Git diff', commandId: 'git.diff', aliases: [], available: true, disabledReason: undefined },
    { kind: 'mapping', keys: ['v', 's'], keyLabel: 'v s', sequence: ['<Space>', 'v', 's'], title: 'Focus search', description: 'Focus search', commandId: 'panel.search.focus', aliases: [], available: true, disabledReason: undefined },
    { kind: 'escape', keys: ['<Esc>'], keyLabel: 'Esc', sequence: ['<Space>', '<Esc>'], title: 'Cancel', description: 'Cancel pending input', commandId: undefined, aliases: [], available: true, disabledReason: undefined },
  ],
};

// Helix info box: the keymap name is the frame title, Esc is implied, a deeper prefix collapses
// into one row named after its commands' namespace, and keys share one padded column.
const text = (row: ReturnType<typeof prefixHelpRows>[number] | undefined): string => row?.segments?.map(segment => segment.text).join('') ?? '';
assert.equal(prefixHelpTitle(prefix), 'Space', 'E20-PREFIX-01 the Space keymap titles its box "Space"');
const widePrefixRows = prefixHelpRows(prefix, 80, 8, theme);
assert.deepEqual(widePrefixRows.map(text), [' m  Select next matching word', ' G  Show changed files (Git is unavailable)', ' v  Panel…'], 'E20-PREFIX-02 one aligned `key  doc` row per choice, sub-prefix grouped, Esc omitted');
assert.equal(prefixHelpTitle({ ...prefix, pendingKeys: ['<C-w>'] }), 'Window', 'E20-PREFIX-03 Ctrl-W titles its box "Window"');
const size = measurePrefixHelp(prefixHelpEntries(prefix), prefixHelpTitle(prefix));
assert.deepEqual(size, { keyWidth: 1, width: ' G  Show changed files (Git is unavailable)'.length + 1, height: 3 }, 'E20-PREFIX-04 the box fits its widest row plus side margins');
const bounds = getPrefixHelpBounds(120, 40, size);
assert.deepEqual(bounds, { width: size.width + 2, height: 5, left: 120 - size.width - 2, top: 39 - 5 }, 'E20-PREFIX-05 the framed box sits bottom-right, directly above the statusline');
const narrowPrefixRows = prefixHelpRows(prefix, 20, 8, theme);
assert.equal(narrowPrefixRows.length, 3, 'E20-PREFIX-06 narrow prefix keeps individual choices visible');
assert.match(text(narrowPrefixRows[0]), /Select next/u, 'E20-PREFIX-07 narrow labels remain useful');

const commandPicker: PickerReadModel = {
  contractVersion: 1,
  mode: 'command',
  query: 'write',
  generation: 1,
  state: 'ready',
  entries: [{ id: 'write', mode: 'command', kind: 'command', label: 'file.save', detail: 'Write the current buffer', value: 'file.save', rootId: undefined, relativePath: undefined, hidden: false, score: 1 }],
  selectedId: 'write',
  totalMatches: 1,
  truncated: false,
  message: undefined,
};
const wideCommandRows = pickerRows(commandPicker, 80, 8, 0, undefined, theme);
assert.match(wideCommandRows[1]?.segments?.map(segment => segment.text).join('') ?? '', /file\.save  Write the current buffer/u, 'E20-COMMAND-01 command picker shows the command and its description');
assert.match(wideCommandRows.at(-1)?.text ?? '', /Enter run/u, 'E20-COMMAND-02 command footer describes execution');
const narrowCommandRows = pickerRows(commandPicker, 40, 8, 0, undefined, theme);
assert.match(narrowCommandRows.at(-1)?.text ?? '', /Enter run/u, 'E20-COMMAND-03 narrow footer keeps the primary action visible');

console.log('T1116 prefix and command picker layouts passed wide and narrow row assertions');
