import assert from 'node:assert/strict';
import { CanonicalInputAdapter } from '../../packages/ui/input/adapter';
import {
  CommandRegistry,
  FocusGraph,
  WorkbenchInputDispatcher,
  type CommandKeyBinding,
  type FocusTarget,
  type WorkbenchInputEnvelope,
} from '../../packages/workbench/src/index';
import { asIdentifier, type CommandId, type Result, type ValidationIssue } from '../../packages/primitives/src/index';
import { defineCommandRegistration, type CommandAvailabilityPolicy, type CommandDescriptorCandidate, type CommandSchema } from '../../packages/contracts/src/index';

interface Empty { readonly value?: string; }
const emptySchema: CommandSchema<Empty> = {
  decode(input: unknown): Result<Empty, readonly ValidationIssue[]> {
    if (input === undefined) return { ok: true, value: {} };
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      ? { ok: true, value: {} }
      : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected object' }] };
  },
};
const outputSchema: CommandSchema<string> = {
  decode(input: unknown): Result<string, readonly ValidationIssue[]> {
    return typeof input === 'string'
      ? { ok: true, value: input }
      : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected string' }] };
  },
};

function id(value: string): CommandId {
  const checked = asIdentifier<CommandId>(value, 'commandId');
  if (!checked.ok) throw new Error(checked.error.message);
  return checked.value;
}

function registration(commandId: string, title: string, availability: CommandAvailabilityPolicy = { contexts: [], requiredCapabilities: [], unavailableReason: 'requires write capability' }) {
  const descriptor: CommandDescriptorCandidate<Empty, string> = {
    id: id(commandId), contractVersion: 1, owner: 't035.fixture', title, help: `${title} help`, category: 'fixture',
    arguments: emptySchema, output: outputSchema, selectionPolicy: 'document-once', effect: 'read', undoPolicy: 'none',
    replayPolicy: 'never', cancellationPolicy: 'non-cancellable', availability,
  };
  return defineCommandRegistration({ descriptor, handler: () => title });
}

function key(key: string, rawBytes = Uint8Array.from([key.charCodeAt(0) ?? 0])): WorkbenchInputEnvelope {
  return { event: { kind: 'key', key, phase: 'press', modifiers: { shift: false, alt: false, ctrl: false, meta: false }, rawBytes }, rawBytes };
}

const editor: FocusTarget = { id: 'editor-main', kind: 'editor', contexts: ['editor', 'normal'] };
const panel: FocusTarget = { id: 'panel-main', kind: 'panel', contexts: ['panel'] };

const registry = new CommandRegistry({ nativeExNames: ['quit', 'write'] });
let editorCalls = 0;
const registered = registry.register({
  commands: [
    registration('xi.t035.editor', 'Editor action', { contexts: ['editor'], requiredCapabilities: [], unavailableReason: 'editor context required' }),
    defineCommandRegistration({
      descriptor: { ...registration('xi.t035.capability', 'Capability action').descriptor, availability: { contexts: [], requiredCapabilities: ['filesystem.write'], unavailableReason: 'Filesystem write capability is unavailable.' } },
      handler: () => { editorCalls += 1; return 'capability'; },
    }),
    registration('xi.t035.panel', 'Panel action', { contexts: ['panel'], requiredCapabilities: [], unavailableReason: 'panel context required' }),
  ],
  aliases: [{ name: 'editor-action', target: { kind: 'command', id: id('xi.t035.editor') } }],
});
assert.equal(registered.ok, true, 'T035-REG-01 foundation registry accepts fixture commands');

const focus = new FocusGraph();
const editorRegistration = focus.register(editor, { focus: true, edges: [{ direction: 'right', targetId: panel.id }] });
assert.equal(editorRegistration.ok, true, 'T035-FOCUS-01 editor target registers');
const panelRegistration = focus.register(panel, { edges: [{ direction: 'left', targetId: editor.id }] });
assert.equal(panelRegistration.ok, true, 'T035-FOCUS-02 panel target registers');
const dispatcher = new WorkbenchInputDispatcher(registry, focus);

function binding(keys: readonly string[], command: string, args?: unknown): CommandKeyBinding {
  return { keys, command: { kind: 'command', id: id(command) }, ...(args === undefined ? {} : { arguments: args }) };
}

const bindings = dispatcher.registerBindings(editor.id, [
  binding(['q'], 'xi.t035.editor'),
  binding(['g', 'g'], 'xi.t035.capability'),
]);
assert.equal(bindings.ok, true, 'T035-DISPATCH-01 bindings register against one registry');

const first = await dispatcher.dispatch(key('q'));
assert.equal(first.kind, 'consumed', 'T035-DISPATCH-02 one key is consumed');
assert.equal(first.kind === 'consumed' ? first.commandId : undefined, 'xi.t035.editor', 'T035-DISPATCH-03 descriptor identity is retained');

const pending = await dispatcher.dispatch(key('g'));
assert.deepEqual(pending, { kind: 'pending', targetId: editor.id, keys: ['g'] }, 'T035-FAIL-PENDING-01 operator-like prefix remains pending');
const overlayTarget: FocusTarget = { id: 'picker-overlay', kind: 'overlay', contexts: ['picker'] };
const overlay = dispatcher.openOverlay(overlayTarget);
assert.equal(overlay.ok, true, 'T035-FOCUS-03 overlay opens');
assert.equal(dispatcher.focus.snapshot.activeTargetId, overlayTarget.id, 'T035-FOCUS-04 overlay owns focus');
const overlayEsc = await dispatcher.dispatch(key('escape', Uint8Array.of(0x1b)));
assert.equal(overlayEsc.kind, 'consumed', 'T035-FAIL-ESC-01 Escape dismisses overlay');
assert.equal(dispatcher.focus.snapshot.activeTargetId, editor.id, 'T035-FOCUS-05 Escape restores prior valid focus');

const unavailable = await dispatcher.dispatch(key('g'));
assert.deepEqual(unavailable, { kind: 'pending', targetId: editor.id, keys: ['g'] }, 'T035-DISPATCH-04 prefix can start again');
const unavailableResult = await dispatcher.dispatch(key('g'));
assert.equal(unavailableResult.kind, 'failed', 'T035-AVAIL-01 unavailable command is consumed as a failed dispatch');
assert.equal(unavailableResult.kind === 'failed' ? unavailableResult.error.kind : undefined, 'unavailable', 'T035-AVAIL-02 unavailable reason is typed');
assert.equal(unavailableResult.kind === 'failed' && unavailableResult.error.kind === 'unavailable' ? unavailableResult.error.reason : undefined, 'Filesystem write capability is unavailable.', 'T035-AVAIL-03 unavailable reason is surfaced');

const palette = dispatcher.readPalette();
assert.equal(palette.entries.length, 3, 'T035-READ-01 palette reads all registry descriptors');
assert.equal(palette.entries.find((entry) => entry.id === 'xi.t035.editor')?.aliases[0], 'editor-action', 'T035-READ-02 palette shares registry aliases');
assert.deepEqual(dispatcher.inspectKey('g').candidates.map((candidate) => candidate.commandId), ['xi.t035.capability'], 'T035-READ-03 key inspection exposes the same binding');

const focusMove = dispatcher.moveFocus('right');
assert.equal(focusMove.ok, true, 'T035-FOCUS-06 explicit edge moves focus deterministically');
assert.equal(focus.snapshot.activeTargetId, panel.id, 'T035-FOCUS-07 edge target is active');
const panelKey = await dispatcher.dispatch(key('q'));
assert.equal(panelKey.kind, 'unhandled', 'T035-DISPATCH-05 inactive editor binding does not receive panel input');

const adapter = new CanonicalInputAdapter({ timeoutMilliseconds: 20 });
const records: string[] = [];
const subscription = adapter.subscribe((record) => records.push(record.kind === 'event' ? record.rawHex : `protocol:${record.rawHex}`));
assert.equal(adapter.push(Uint8Array.of(0xc3)).length, 0, 'T035-UTF8-01 split lead byte waits beyond parser timeout');
assert.equal(adapter.flushTimeout(20).length, 0, 'T035-UTF8-02 parser timeout does not flush a pending UTF-8 scalar');
const validUtf8 = adapter.push(Uint8Array.of(0xa9));
assert.equal(validUtf8.length, 1, 'T035-UTF8-03 continuation completes one text event');
assert.equal(validUtf8[0]?.kind, 'event', 'T035-UTF8-04 valid split text is an input event');
assert.equal(validUtf8[0]?.kind === 'event' ? validUtf8[0].event.kind === 'key' && validUtf8[0].event.key === 'é' : false, true, 'T035-UTF8-05 split UTF-8 remains text');
const invalidRecords = adapter.push(Uint8Array.of(0xc3, 0x41));
assert.equal(invalidRecords[0]?.kind, 'event', 'T035-UTF8-06 invalid lead produces text before reprocessing ASCII');
assert.equal(invalidRecords.some((record) => record.kind === 'event' && record.event.kind === 'key' && record.event.key === 'Alt'), false, 'T035-UTF8-07 invalid partial bytes never become an Alt command');
const sgrBytes = Uint8Array.from([0x1b, 0x5b, 0x3c, 0x30, 0x3b, 0x36, 0x3b, 0x33, 0x4d]);
const sgr = adapter.push(sgrBytes);
assert.equal(sgr[0]?.kind === 'event' ? sgr[0].rawHex : undefined, '1b5b3c303b363b334d', 'T035-RAW-01 SGR bytes remain exact');
const x10Bytes = Uint8Array.from([0x1b, 0x5b, 0x4d, 0x20, 0xf3, 0xa1]);
const x10 = adapter.push(x10Bytes);
assert.equal(x10[0]?.kind === 'event' ? x10[0].rawHex : undefined, '1b5b4d20f3a1', 'T035-RAW-02 high-byte legacy X10 bytes remain exact');
assert.equal(records.length, 5, 'T035-INPUT-01 each parser event reaches its subscriber exactly once');
subscription.dispose();
adapter.dispose();

const adapterForDispatch = new CanonicalInputAdapter();
const qRecord = adapterForDispatch.push(Uint8Array.of(0x71))[0];
assert.equal(qRecord?.kind, 'event', 'T035-INPUT-02 adapter emits a canonical event for dispatcher');
if (qRecord?.kind === 'event') {
  await dispatcher.focusTarget(editor.id);
  const result = await dispatcher.dispatch({ event: qRecord.event, rawBytes: qRecord.rawBytes });
  assert.equal(result.kind, 'consumed', 'T035-INPUT-03 canonical event reaches one focused target');
  assert.equal(dispatcher.readDiagnostics().at(-1)?.rawHex, '71', 'T035-RAW-03 dispatcher retains exact key bytes');
}
adapterForDispatch.dispose();

assert.equal((await dispatcher.focusTarget(editor.id)).ok, true, 'T035-FOCUS-08 focus helper returns a successful void result');
if (editorRegistration.ok) editorRegistration.value.dispose();
const disposedTarget = await dispatcher.dispatch(key('q'));
assert.equal(disposedTarget.kind, 'unhandled', 'T035-FAIL-DISPOSED-01 disposed focus target cannot receive input');
assert.equal(disposedTarget.kind === 'unhandled' ? disposedTarget.reason : undefined, 'focus-target-disposed', 'T035-FAIL-DISPOSED-02 disposal reason is visible');

dispatcher.dispose();
focus.dispose();
await registry.dispose();
console.log('T035 dispatcher passed exact-once input, deterministic focus, overlay cancellation, palette inspection, availability, UTF-8 and X10 byte fixtures');
