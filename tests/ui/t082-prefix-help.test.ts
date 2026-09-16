import assert from 'node:assert/strict';
import {
  PrefixHelpController,
  PrefixHelpRenderable,
  formatPrefixHelpLines,
  type PrefixHelpClock,
  type PrefixHelpGenerations,
  type PrefixHelpSource,
} from '../../packages/ui/help/index';
import type { PrefixHelpReadModel } from '../../packages/workbench/src/index';
import { createTestRenderer } from '@opentui/core/testing';
import {
  CommandRegistry,
  FocusGraph,
  WorkbenchInputDispatcher,
  type FocusTarget,
  type PrefixHelpRequest,
} from '../../packages/workbench/src/index';
import { compileVimMappings, flushVimMapping, initialVimMappingState, resolveVimMapping } from '../../packages/vim/src/index';
import { asIdentifier, type CommandId, type Result, type ValidationIssue } from '../../packages/primitives/src/index';
import { defineCommandRegistration, type CommandDescriptorCandidate, type CommandSchema } from '../../packages/contracts/src/index';

interface Empty {}
const emptySchema: CommandSchema<Empty> = {
  decode(input: unknown): Result<Empty, readonly ValidationIssue[]> {
    return input === undefined || (input !== null && typeof input === 'object' && !Array.isArray(input))
      ? { ok: true, value: {} }
      : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected object' }] };
  },
};
const outputSchema: CommandSchema<string> = {
  decode(input: unknown): Result<string, readonly ValidationIssue[]> {
    return typeof input === 'string' ? { ok: true, value: input } : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected string' }] };
  },
};
function id(value: string): CommandId {
  const checked = asIdentifier<CommandId>(value, 'commandId');
  if (!checked.ok) throw new Error(checked.error.message);
  return checked.value;
}
function command(commandId: string, title: string, requiredCapabilities: readonly string[] = []) {
  const descriptor: CommandDescriptorCandidate<Empty, string> = {
    id: id(commandId), contractVersion: 1, priority: 0, owner: 't082.fixture', title, help: `${title} help`, category: 'fixture',
    arguments: emptySchema, output: outputSchema, selectionPolicy: 'document-once', effect: 'read', undoPolicy: 'none',
    replayPolicy: 'never', cancellationPolicy: 'non-cancellable', availability: {
      contexts: ['editor'], requiredCapabilities, unavailableReason: 'Requires the fixture capability.',
    },
  };
  return defineCommandRegistration({ descriptor, handler: () => title });
}

class ManualClock implements PrefixHelpClock {
  #next = 1;
  readonly tasks = new Map<number, () => void>();
  setTimeout(callback: () => void, _milliseconds: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.tasks.set(handle, callback);
    return handle;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  fireAll(): void {
    const pending = [...this.tasks.values()];
    this.tasks.clear();
    for (const callback of pending) callback();
  }
  get pendingCount(): number { return this.tasks.size; }
}

const registry = new CommandRegistry({ nativeExNames: ['quit', 'write'] });
const registered = registry.register({
  commands: [
    command('xi.t082.delete-word', 'Delete word'),
    command('xi.t082.capability', 'Needs workspace', ['workspace.write']),
    command('xi.t082.leader', 'Leader action'),
  ],
  aliases: [{ name: 'delete-word', target: { kind: 'command', id: id('xi.t082.delete-word') } }],
});
assert.equal(registered.ok, true, 'T082-REG-01 fixture commands register through one registry');
const editor: FocusTarget = { id: 'editor-t082', kind: 'editor', contexts: ['editor', 'normal'] };
const focus = new FocusGraph();
const focused = focus.register(editor, { focus: true });
assert.equal(focused.ok, true, 'T082-FOCUS-01 editor target is focused');
const dispatcher = new WorkbenchInputDispatcher(registry, focus);
const bindings = dispatcher.registerBindings(editor.id, [
  { keys: ['d', 'w'], command: { kind: 'command', id: id('xi.t082.delete-word') }, contexts: ['editor', 'normal'], description: 'Delete the next word' },
  { keys: ['<Space>', 'm', 'a'], command: { kind: 'command', id: id('xi.t082.leader') }, contexts: ['editor', 'normal'], description: 'Add next occurrence' },
  { keys: ['g', 'd'], command: { kind: 'command', id: id('xi.t082.capability') }, contexts: ['editor', 'normal'] },
]);
assert.equal(bindings.ok, true, 'T082-BIND-01 active mappings register with descriptions');
let configGeneration = 1;
const source: PrefixHelpSource = {
  readGenerations(): PrefixHelpGenerations {
    return Object.freeze({ registryGeneration: registry.snapshot.generation, configGeneration, focusGeneration: focus.snapshot.generation });
  },
  readPrefixHelp(request: PrefixHelpRequest) { return dispatcher.readPrefixHelp(request); },
};
const clock = new ManualClock();
const controller = new PrefixHelpController(source, { clock });
const readModel = (): PrefixHelpReadModel | undefined => controller.model;

const parserD = Object.freeze([
  { kind: 'motions' as const, keys: Object.freeze(['w', 'e', 'b']), label: 'Choose a motion' },
  { kind: 'escape' as const, label: 'Cancel pending input' },
]);
controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
assert.equal(clock.pendingCount, 1, 'T082-TIMER-01 one independent timer is armed');
assert.equal(readModel(), undefined, 'T082-TIMER-02 help remains hidden before the delay');
clock.fireAll();
const dModel: PrefixHelpReadModel | undefined = readModel();
if (dModel === undefined) throw new Error('T082-no-d-model');
assert.ok(dModel.hints.some((hint) => hint.kind === 'parser' && hint.keyLabel.includes('w')), 'E20-D-01 d exposes parser motion continuations');
assert.ok(dModel.hints.some((hint) => hint.kind === 'escape'), 'E20-D-02 d exposes cancellation');
assert.equal(dModel.registryGeneration, registry.snapshot.generation, 'T082-GENERATION-01 help captures registry generation');
assert.deepEqual(formatPrefixHelpLines(dModel, 40, 4).length, 1, 'E20-NARROW-01 narrow help collapses to a bounded status row');
assert.equal(dispatcher.focus.snapshot.activeTargetId, editor.id, 'E20-FOCUS-01 help does not steal focus');
const panelSetup = await createTestRenderer({ width: 80, height: 4, bufferedOutput: 'memory' });
const panel = new PrefixHelpRenderable(panelSetup.renderer.root.ctx, { help: controller, width: 80, height: 4 });
panelSetup.renderer.root.add(panel);
await panelSetup.renderOnce();
assert.match(panelSetup.captureCharFrame(), /Prefix/u, 'E20-RENDER-01 passive panel renders the active prefix model');
panelSetup.resize(32, 4);
await panelSetup.renderOnce();
assert.ok(panelSetup.captureCharFrame().split('\n').filter((line) => line.trim() !== '').length <= 4, 'E20-RENDER-02 narrow panel remains bounded to available rows');
panelSetup.renderer.destroy();
assert.equal(panel.isDestroyed, true, 'E20-RENDER-03 panel subscription is disposed with its renderable');

controller.schedule({ targetId: editor.id, pendingKeys: ['<Space>'], parserContinuations: [], configGeneration });
clock.fireAll();
const leaderModel: PrefixHelpReadModel | undefined = readModel();
if (leaderModel === undefined) throw new Error('T082-no-leader-model');
assert.ok(leaderModel.hints.some((hint) => hint.kind === 'mapping' && hint.keyLabel === 'm a'), 'E20-LEADER-01 leader mapping is shown');
assert.equal(leaderModel.hints.find((hint) => hint.kind === 'mapping')?.aliases[0], undefined, 'T082-ALIAS-01 alias rows remain metadata-only when mapped command has a different alias');
const unavailable = dispatcher.readPrefixHelp({ targetId: editor.id, pendingKeys: ['g'], parserContinuations: [], configGeneration, availability: { contexts: ['editor'], capabilities: [] } });
const unavailableHint = unavailable.hints.find((hint) => hint.kind === 'mapping');
assert.equal(unavailableHint?.available, false, 'E20-CAPABILITY-01 missing capability remains visible as unavailable');
assert.equal(unavailableHint?.disabledReason, 'Requires the fixture capability.', 'E20-CAPABILITY-02 unavailable reason is truthful');

const userMapping = compileVimMappings('xi', [{ mode: 'normal', lhs: ['<Space>', 'm'], rhs: ['x'] }], { timeoutMilliseconds: 500 });
assert.equal(userMapping.ok, true, 'E20-TIMING-01 mapping timeout fixture compiles');
if (!userMapping.ok) throw new Error('T082-mapping-fixture');
const mappingPending = resolveVimMapping(userMapping.value, initialVimMappingState('normal'), '<Space>', 0);
assert.equal(mappingPending.kind, 'pending', 'E20-TIMING-02 native/user mapping remains pending after its prefix');
controller.schedule({ targetId: editor.id, pendingKeys: ['<Space>'], parserContinuations: [], configGeneration });
clock.fireAll();
const mappingStillPending = mappingPending.kind === 'pending'
  ? flushVimMapping(userMapping.value, mappingPending.state, 300)
  : undefined;
assert.equal(mappingStillPending?.kind, 'pending', 'E20-TIMING-03 help timer does not flush or shorten mapping timeout');

let completed = false;
const dispatchedPrefix = await dispatcher.dispatch({ event: { kind: 'key', key: 'd', phase: 'press', modifiers: { shift: false, alt: false, ctrl: false, meta: false }, rawBytes: Uint8Array.of(0x64) } });
assert.equal(dispatchedPrefix.kind, 'pending', 'E20-TIMING-04 command prefix can be pending while help is scheduled');
controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
const dispatchedCommand = await dispatcher.dispatch({ event: { kind: 'key', key: 'w', phase: 'press', modifiers: { shift: false, alt: false, ctrl: false, meta: false }, rawBytes: Uint8Array.of(0x77) } });
completed = dispatchedCommand.kind === 'consumed';
controller.completeCommand();
clock.fireAll();
assert.equal(completed, true, 'E20-TIMING-05 completing the command still dispatches exactly once');
assert.equal(readModel(), undefined, 'E20-TIMING-06 completed command clears help before delayed paint');
assert.equal(clock.pendingCount, 0, 'E20-TIMING-07 completed command leaves no hint timer');

const parserLiteral = Object.freeze([
  { kind: 'literal-character' as const, label: 'Type one literal character' },
]);
controller.schedule({ targetId: editor.id, pendingKeys: ['f'], parserContinuations: parserLiteral, configGeneration });
clock.fireAll();
const fModel: PrefixHelpReadModel | undefined = readModel();
if (fModel === undefined) throw new Error('T082-no-f-model');
assert.equal(fModel.hints.find((hint) => hint.kind === 'literal')?.keyLabel, 'one character', 'E20-LITERAL-F-01 f shows a literal prompt');
controller.schedule({ targetId: editor.id, pendingKeys: ['r'], parserContinuations: parserLiteral, configGeneration });
clock.fireAll();
const rModel: PrefixHelpReadModel | undefined = readModel();
if (rModel === undefined) throw new Error('T082-no-r-model');
assert.equal(rModel.hints.find((hint) => hint.kind === 'literal')?.description, 'Type one literal character', 'E20-LITERAL-R-01 r remains a prompt and does not become a filter');

controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
configGeneration += 1;
clock.fireAll();
assert.equal(readModel(), undefined, 'EX04-STALE-CONFIG-01 a delayed hint from an old config generation is discarded');
controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
clock.fireAll();
const reloadedModel: PrefixHelpReadModel | undefined = readModel();
if (reloadedModel === undefined) throw new Error('T082-no-reloaded-model');
const beforeRegistry = reloadedModel.registryGeneration;
controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
const later = registry.register({ commands: [command('xi.t082.reload', 'Reloaded action')] });
assert.equal(later.ok, true, 'EX04-RELOAD-02 registry reload publishes a new generation');
clock.fireAll();
assert.equal(readModel(), undefined, 'EX04-RELOAD-03 registry generation change cancels stale delayed help');
assert.notEqual(beforeRegistry, registry.snapshot.generation, 'EX04-RELOAD-04 registry generation advances independently');

controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
controller.cancel();
clock.fireAll();
assert.equal(readModel(), undefined, 'T082-CANCEL-01 completed/cancelled input cannot reveal delayed help');
assert.equal(clock.pendingCount, 0, 'T082-IDLE-01 no idle timer remains after cancel');
controller.schedule({ targetId: editor.id, pendingKeys: ['d'], parserContinuations: parserD, configGeneration });
controller.dispose();
assert.equal(clock.pendingCount, 0, 'T082-DISPOSE-01 disposal clears the independent timer');
clock.fireAll();
assert.equal(readModel(), undefined, 'T082-DISPOSE-02 disposed controller ignores late timer callbacks');

void dispatcher.dispose();
void focus.dispose();
void registry.dispose();
console.log('T082 prefix help passed E20 legal continuations, literal prompts, independent timing, generation cancellation, capability reasons, narrow rendering and disposal fixtures');
