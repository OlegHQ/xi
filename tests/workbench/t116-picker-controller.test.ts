import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { CancellationSource, type ClockPort, type Disposable, type PlatformFailure, type Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import { PickerController, ThemeController, type PickerModelPort, type WorkbenchPickerEntry, type WorkbenchPickerFailure, type WorkbenchPickerMode, type ThemeFilesystemPort } from '../../packages/workbench/picker/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-picker-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value = 'alpha\n'): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const failure: PlatformFailure = { code: 'unsupported', message: 'not implemented in this fixture', retryable: false };
const notImplemented: ThemeFilesystemPort = {
  readFile: async () => ({ ok: false, error: failure }),
  writeFileAtomic: async () => ({ ok: true, value: undefined }),
  makeDirectory: async () => ({ ok: true, value: undefined }),
};

// -- A fake picker model port: entries are set by the test per query. --
class FakePickerModel<TEntry extends WorkbenchPickerEntry> implements PickerModelPort<TEntry> {
  entries: readonly TEntry[] = [];
  selectedId: string | undefined;
  cancelled = 0;
  get model(): { readonly entries: readonly TEntry[]; readonly selectedId: string | undefined } {
    return { entries: this.entries, selectedId: this.selectedId };
  }
  async query(_mode: WorkbenchPickerMode, _query: string): Promise<Result<{ readonly entries: readonly TEntry[] }, WorkbenchPickerFailure>> {
    this.selectedId = this.entries[0]?.id;
    return { ok: true, value: { entries: this.entries } };
  }
  select(entryId: string): boolean {
    if (!this.entries.some((entry) => entry.id === entryId)) return false;
    this.selectedId = entryId;
    return true;
  }
  cancel(): void { this.cancelled += 1; }
}

interface FixtureEntry extends WorkbenchPickerEntry {}

const launchDocumentId = id<DocumentId>('T116-picker-launch-document');
const launchDocument = document(launchDocumentId);
const session = new WorkbenchSession({ workspaceId: 'T116-picker' });
const launchViewId = id<ViewId>('T116-picker-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });

const disk = new Map<string, string>([['/workspace/a.txt', 'a-content\n']]);
const host = new BufferHost(session, launchDocument, {
  openDocument: async (path, documentId) => {
    const content = disk.get(path);
    return content === undefined ? undefined : document(documentId, content);
  },
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const theme = new ThemeController<string>({
  initial: new Map([['light', 'light-theme'], ['dark', 'dark-theme']]),
  defaultId: 'light',
  filesystem: notImplemented,
  statePath: '/does/not/matter/state.json',
  stateDirectory: '/does/not/matter',
});
let appliedTheme: string | undefined;
theme.bindSetTheme((value) => { appliedTheme = value; });

const model = new FakePickerModel<FixtureEntry>();
const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const secondaryActions: Array<{ readonly entryId: string; readonly key: string }> = [];
const diagnosticJumps: string[] = [];

const testClock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};

const picker = new PickerController<FixtureEntry, string>({
  host,
  model,
  theme,
  clock: testClock,
  marker: (name, payload) => { markers.push({ name, payload }); },
  startFileIndexPopulation: async () => {},
  toggleMouseMode: () => true,
  openDiagnostic: async diagnosticId => { diagnosticJumps.push(diagnosticId); },
  openFile: (path, preview) => host.openBufferAtPath(path, { preview }),
  onSecondaryAction: (entry, key) => { secondaryActions.push({ entryId: entry.id, key }); },
});

// T116-PICKER-01: opening the theme picker begins a preview session on the applied theme;
// navigating or pointer-hovering a different theme applies it live without persisting yet.
assert.equal(theme.activeId, 'light', 'T116-PICKER-01a starts on the default theme');
model.entries = [
  { id: 'dark', mode: 'theme', value: 'dark' },
  { id: 'light', mode: 'theme', value: 'light' },
];
picker.open('theme');
await flush();
assert.equal(picker.isOpen, true, 'T116-PICKER-01b the picker is open');
assert.equal(theme.activeId, 'light', 'T116-PICKER-01c opening selects the active theme, not the first alphabetical result');
assert.equal(model.selectedId, 'light', 'T116-PICKER-01d the active theme is visibly selected');
assert.equal(appliedTheme, 'light-theme', 'T116-PICKER-01e the UI-facing setTheme port receives the active theme');
model.select('dark');
picker.previewSelected();
assert.equal(theme.activeId, 'dark', 'T116-PICKER-01f the shared selected-entry preview path applies hover/key selection live');
assert.equal(appliedTheme, 'dark-theme', 'T116-PICKER-01g the preview uses the UI-facing setTheme port');

// T116-PICKER-02: escape cancels the picker and reverts the previewed theme.
await picker.handleKeypress({ name: 'escape', raw: '', shift: false, option: false, ctrl: false, meta: false });
assert.equal(picker.isOpen, false, 'T116-PICKER-02a escape closes the picker');
assert.equal(theme.activeId, 'light', 'T116-PICKER-02b escape reverts the live preview');
assert.equal(appliedTheme, 'light-theme', 'T116-PICKER-02c the revert goes through the setTheme port too');

// Direct pointer activation must commit the clicked entry even without a prior hover.
picker.open('theme');
await flush();
await picker.activateEntry({ id: 'dark', mode: 'theme', value: 'dark' });
assert.equal(theme.activeId, 'dark');
picker.open('theme');
await flush();
assert.equal(model.selectedId, 'dark', 'reopening selects the committed theme');
await picker.handleKeypress({ name: 'n', raw: '\u000e', ctrl: true, shift: false, option: false, meta: false });
assert.equal(theme.activeId, 'light', 'Ctrl-N previews the next theme');
await picker.handleKeypress({ name: 'p', raw: '\u0010', ctrl: true, shift: false, option: false, meta: false });
assert.equal(theme.activeId, 'dark', 'Ctrl-P previews the previous theme');
await picker.close(true);

model.entries = Array.from({ length: 40 }, (_, index) => ({ id: `theme-${index}`, mode: 'theme', value: `theme-${index}` }));
for (const entry of model.entries) theme.addCustomTheme(entry.value, entry.value, entry.value);
theme.setActiveId('theme-30');
picker.setVisibleRows(12);
picker.open('theme');
await flush();
assert.equal(model.selectedId, 'theme-30', 'the current theme need not be near the start');
await picker.handleKeypress({ name: 'u', raw: '\u0015', ctrl: true, shift: false, option: false, meta: false });
assert.equal(theme.activeId, 'theme-24', 'Ctrl-U moves half a visible page');
await picker.handleKeypress({ name: 'd', raw: '\u0004', ctrl: true, shift: false, option: false, meta: false });
assert.equal(theme.activeId, 'theme-30', 'Ctrl-D moves half a visible page');
await picker.close(true);

// T116-PICKER-03: enter on a file entry promotes the buffer (not a preview) and closes.
model.entries = [{ id: 'a', mode: 'file', value: '/workspace/a.txt' }];
picker.open('file');
await flush();
model.selectedId = 'a';
await picker.handleKeypress({ name: 'enter', raw: '\r', shift: false, option: false, ctrl: false, meta: false });
await flush();
assert.equal(picker.isOpen, false, 'T116-PICKER-03a enter on a file entry closes the picker');
const opened = session.buffers().find((buffer) => buffer.path === '/workspace/a.txt');
assert.ok(opened !== undefined, 'T116-PICKER-03b the file buffer was opened');
assert.equal(opened?.preview, false, 'T116-PICKER-03c committing a file entry never leaves it as a preview buffer');
assert.equal(host.previewViewId, undefined, 'T116-PICKER-03d no preview view is left tracked after a commit');

// T116-PICKER-04: enter on a 'git' entry opens it the same way a 'file' entry does.
disk.set('/workspace/b.txt', 'b-content\n');
model.entries = [{ id: 'b.txt', mode: 'git', value: '/workspace/b.txt' }];
picker.open('git');
await flush();
model.selectedId = 'b.txt';
await picker.handleKeypress({ name: 'enter', raw: '\r', shift: false, option: false, ctrl: false, meta: false });
await flush();
assert.equal(picker.isOpen, false, 'T116-PICKER-04a enter on a git entry closes the picker');
const openedGit = session.buffers().find((buffer) => buffer.path === '/workspace/b.txt');
assert.ok(openedGit !== undefined, 'T116-PICKER-04b the git entry opened its file through the same openBufferAtPath route');

// T116-PICKER-05: 's'/'u' in git mode dispatch onSecondaryAction instead of typing into the
// filter query, and are ignored outside git mode.
model.entries = [{ id: 'c.txt', mode: 'git', value: '/workspace/c.txt' }];
picker.open('git');
await flush();
model.selectedId = 'c.txt';
await picker.handleKeypress({ name: 's', raw: 's', shift: false, option: false, ctrl: false, meta: false });
await picker.handleKeypress({ name: 'u', raw: 'u', shift: false, option: false, ctrl: false, meta: false });
assert.deepEqual(secondaryActions, [{ entryId: 'c.txt', key: 'stage' }, { entryId: 'c.txt', key: 'unstage' }], 'T116-PICKER-05a stage/unstage keys reach onSecondaryAction with the selected entry');
await picker.close(true);

model.entries = [{ id: 'd', mode: 'file', value: '/workspace/a.txt' }];
picker.open('file');
await flush();
secondaryActions.length = 0;
await picker.handleKeypress({ name: 's', raw: 's', shift: false, option: false, ctrl: false, meta: false });
assert.equal(secondaryActions.length, 0, 'T116-PICKER-05b s/u outside git mode falls through to the ordinary filter-query path');
await picker.close(true);

// Diagnostics reuse query/selection/cancel without opening a preview buffer.
model.entries = [{ id: 'problem-1', mode: 'diagnostic', value: 'problem-1' }, { id: 'problem-2', mode: 'diagnostic', value: 'problem-2' }];
picker.open('diagnostic');
await flush();
model.selectedId = 'problem-2';
picker.refresh();
await flush();
assert.equal(model.selectedId, 'problem-2', 'live diagnostic refresh retains selected identity');
assert.equal(diagnosticJumps.length, 0, 'preview never changes editor position');
await picker.handleKeypress({ name: 'return', raw: '\r', shift: false, option: false, ctrl: false, meta: false });
assert.deepEqual(diagnosticJumps, ['problem-2']);
assert.equal(picker.isOpen, false);

// A new preview during asynchronous persistence must not replace the committed id on disk.
let releaseDirectory: () => void = () => {};
const directoryReady = new Promise<void>(resolve => { releaseDirectory = resolve; });
let persisted = '';
const delayedTheme = new ThemeController<string>({
  initial: new Map([['light', 'light'], ['dark', 'dark']]), defaultId: 'light',
  statePath: '/fixture/state.json', stateDirectory: '/fixture',
  filesystem: {
    ...notImplemented,
    makeDirectory: async () => { await directoryReady; return { ok: true, value: undefined }; },
    writeFileAtomic: async (_path, bytes) => { persisted = new TextDecoder().decode(bytes); return { ok: true, value: undefined }; },
  },
});
const persistenceCancellation = new CancellationSource();
const savingTheme = delayedTheme.persistActiveId(persistenceCancellation.token);
delayedTheme.preview('dark');
releaseDirectory();
await savingTheme;
assert.equal(JSON.parse(persisted).theme, 'light', 'persist the committed id captured before asynchronous IO');
persistenceCancellation.dispose();

console.log('T116 PickerController/ThemeController passed theme-preview-revert, file-commit, git-entry-open and git secondary-action fixtures');
