import assert from 'node:assert/strict';
import { PickerController, type WorkbenchPickerEntry } from '../../packages/workbench/picker/index';

// H2-1: apps/xi/src/wiring/controllers.ts used to decide the git picker's `s` (stage) vs
// `u` (unstage) key policy itself (`key === 's' ? stage : unstage`); the app was implementing
// Vim/keymap-adjacent input policy instead of just wiring a callback. PickerController now
// resolves the key to a semantic 'stage' | 'unstage' action before calling back, so the
// composition root only maps that action to a git mutation.

interface FakeEntry extends WorkbenchPickerEntry { readonly id: string; readonly mode: 'git'; readonly value: string; }

function makeController(entries: readonly FakeEntry[], onSecondaryAction: (entry: FakeEntry, action: 'stage' | 'unstage') => void): PickerController<FakeEntry> {
  const model = {
    model: { entries, selectedId: entries[0]?.id },
    query: async () => ({ ok: true as const, value: { entries } }),
    select: () => true,
    cancel: () => {},
  };
  const host = {
    closeAllPanels: () => {},
    previewViewId: undefined,
    discardPreviewView: () => ({ ok: false as const }),
    notifySurfaceChange: () => {},
  } as unknown as ConstructorParameters<typeof PickerController>[0]['host'];
  const theme = { beginPreview: () => {}, endPreview: () => {}, preview: () => false, commit: () => {} } as unknown as ConstructorParameters<typeof PickerController>[0]['theme'];
  return new PickerController<FakeEntry>({
    host,
    model,
    theme,
    clock: { monotonicMilliseconds: () => 0, schedule: () => ({ dispose() {} }), sleep: async () => ({ ok: true, value: undefined }) },
    marker: () => {},
    startFileIndexPopulation: async () => {},
    toggleMouseMode: () => false,
    openFile: (() => { throw new Error('h2-1 smoke never opens a file'); }) as never,
    onSecondaryAction: onSecondaryAction as (entry: WorkbenchPickerEntry, action: 'stage' | 'unstage') => void,
  });
}

const entry: FakeEntry = { id: 'a.txt', mode: 'git', value: 'a.txt' };
const seen: Array<'stage' | 'unstage'> = [];
const controller = makeController([entry], (_entry, action) => seen.push(action));
controller.open('git');

await controller.handleKeypress({ name: 's', raw: 's', shift: false, option: false, ctrl: false, meta: false } as never);
await controller.handleKeypress({ name: 'u', raw: 'u', shift: false, option: false, ctrl: false, meta: false } as never);

assert.deepEqual(seen, ['stage', 'unstage'], 'H2-1 PickerController resolves s/u keys to stage/unstage before calling the composition root back');

console.log('H2-1 PickerController owns the git-picker s/u key -> stage/unstage action policy');
