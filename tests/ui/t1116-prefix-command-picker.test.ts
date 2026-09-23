import assert from 'node:assert/strict';
import { DARK_WORKBENCH_THEME } from '../../packages/ui/theme/workbench-themes';
import { pickerRows, prefixHelpRows } from '../../packages/ui/src/solid/workbench';
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
    { kind: 'mapping', keys: ['g', 's'], keyLabel: 'g s', sequence: ['<Space>', 'g', 's'], title: 'Open source control', description: 'Show changed files', commandId: 'git.open', aliases: [], available: false, disabledReason: 'Git is unavailable' },
  ],
};

const widePrefixRows = prefixHelpRows(prefix, 80, 8, theme);
assert.equal(widePrefixRows.length, 3, 'E20-PREFIX-01 wide prefix renders a title and every legal continuation');
assert.equal(widePrefixRows[1]?.segments?.[0]?.text.length, widePrefixRows[2]?.segments?.[0]?.text.length, 'E20-PREFIX-02 key labels share an aligned column');
assert.match(widePrefixRows[2]?.segments?.at(-1)?.text ?? '', /Git is unavailable/u, 'E20-PREFIX-03 unavailable action explains its disabled state');
const narrowPrefixRows = prefixHelpRows(prefix, 32, 8, theme);
assert.equal(narrowPrefixRows.length, 3, 'E20-PREFIX-04 narrow prefix keeps individual choices visible');
assert.match(narrowPrefixRows[1]?.segments?.map(segment => segment.text).join('') ?? '', /Add next/u, 'E20-PREFIX-05 narrow labels remain useful');

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
