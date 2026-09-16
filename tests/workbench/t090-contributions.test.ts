import assert from 'node:assert/strict';
import {
  asIdentifier,
  CancellationSource,
  type CommandAvailabilityPolicy,
  type CommandDescriptorCandidate,
  type CommandId,
  type CommandSchema,
  type ContributionProvider,
  type ContributionReadPort,
  type ContributionRegistryHost,
  type DocumentVersion,
  type FeatureContributionModule,
  type ProviderId,
  type Result,
  type SelectionGeneration,
  type Utf16Offset,
  type UndoGroupId,
  defineCommandRegistration,
} from '../../packages/contracts/src/index';
import { CommandRegistry, ContributionRegistry, createExampleContributionModule } from '../../packages/workbench/src/index';

type ArgumentsValue = { readonly value: string };
const argumentsSchema: CommandSchema<ArgumentsValue> = {
  decode(input: unknown): Result<ArgumentsValue, readonly { readonly path: string; readonly code: 'invalid-type'; readonly message: string }[]> {
    if (input === null || typeof input !== 'object' || !('value' in input) || typeof input.value !== 'string') {
      return { ok: false, error: [{ path: '$.value', code: 'invalid-type', message: 'value must be a string' }] };
    }
    return { ok: true, value: { value: input.value } };
  },
};
const outputSchema: CommandSchema<string> = {
  decode(input: unknown): Result<string, readonly { readonly path: string; readonly code: 'invalid-type'; readonly message: string }[]> {
    return typeof input === 'string'
      ? { ok: true, value: input }
      : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'result must be text' }] };
  },
};
const availability: CommandAvailabilityPolicy = {
  contexts: [],
  requiredCapabilities: [],
  unavailableReason: 'Example command is unavailable.',
};

function commandId(value: string): CommandId {
  const result = asIdentifier<CommandId>(value, 'commandId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function providerId(value: string): ProviderId {
  const result = asIdentifier<ProviderId>(value, 'providerId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function descriptor(id: string): CommandDescriptorCandidate<ArgumentsValue, string> {
  return {
    id: commandId(id),
    contractVersion: 1,
    owner: 'tests.t090',
    title: 'Example read',
    help: 'Read the contribution snapshot.',
    category: 'example',
    arguments: argumentsSchema,
    output: outputSchema,
    selectionPolicy: 'workspace-once',
    effect: 'read',
    undoPolicy: 'none',
    replayPolicy: 'never',
    cancellationPolicy: 'cancellable',
    availability,
  };
}

const host: ContributionRegistryHost<string> = {
  read: {
    read: () => 'snapshot-read',
  } satisfies ContributionReadPort<string>,
  selectionGeneration: 7 as SelectionGeneration,
  edit: {
    propose: async (proposal, cancellation) => cancellation.isCancelled
      ? { ok: false, error: { kind: 'cancelled' } }
      : { ok: true, value: { version: proposal.expectedVersion, origin: proposal.origin } },
  },
};

function readExampleModule(reads: { value: number }): FeatureContributionModule<string> {
  return {
    id: 'example.read',
    contractVersion: 1,
    owner: 'tests.t090',
    priority: 10,
    scope: 'workspace',
    activate(context) {
      const registration = context.registerCommands({
        commands: [defineCommandRegistration<ArgumentsValue, string>({
          descriptor: descriptor('xi.example.read'),
          handler: () => {
            reads.value += 1;
            return context.read.read();
          },
        })],
        aliases: [{ name: 'example-read', target: { kind: 'command', id: commandId('xi.example.read') } }],
      });
      assert.equal(registration.ok, true, 'EX01 command registration uses the public contract');
      const model = context.registerModel({
        id: 'example.picker',
        contractVersion: 1,
        owner: 'tests.t090',
        kind: 'picker',
        priority: 2,
        scope: 'workspace',
        read: (modelContext) => ({
          title: modelContext.read.read(),
          selectionGeneration: Number(modelContext.selectionGeneration),
        }),
      });
      assert.equal(model.ok, true, 'EX01 picker model registers through the public port');
      const provider = context.registerProvider({
        id: providerId('example.formatter'),
        contractVersion: 1,
        owner: 'tests.t090',
        capabilities: ['format'],
        priority: 3,
        scope: 'document',
        provide: async (_query, providerContext) => {
          const edit = providerContext.edit;
          if (edit === undefined) return { ok: false, error: { kind: 'unavailable', message: 'edit port unavailable' } };
          const result = await edit.propose({
            expectedVersion: 0 as DocumentVersion,
            edits: [{ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: 'x' }],
            origin: 'example.formatter',
            undoGroup: 'example-undo' as UndoGroupId,
          }, providerContext.cancellation);
          return { ok: true, value: { proposed: result.ok } };
        },
      } satisfies ContributionProvider);
      assert.equal(provider.ok, true, 'EX02 edit proposal provider registers through the public port');
    },
  };
}

const commands = new CommandRegistry({ nativeExNames: ['quit', 'write'] });
const registry = new ContributionRegistry({ commands, host });
const reads = { value: 0 };
const activated = await registry.activate(readExampleModule(reads));
assert.equal(activated.ok, true, 'EX01 example module activates exactly once');
if (!activated.ok) throw new Error('example activation failed');
assert.deepEqual(registry.snapshot.modules, ['example.read']);

const dispatched = await commands.dispatch({ kind: 'alias', name: 'example-read' }, { value: 'from-palette' });
assert.deepEqual(dispatched, { ok: true, value: 'snapshot-read' }, 'EX01 alias dispatch reaches the registered command');
assert.equal(reads.value, 1, 'EX01 one dispatch invokes the handler once');
const model = await registry.readModel('example.picker');
assert.deepEqual(model, {
  ok: true,
  value: {
    value: { title: 'snapshot-read', selectionGeneration: 7 },
    origin: { moduleId: 'example.read', contributionId: 'example.picker', registryGeneration: registry.snapshot.generation },
  },
}, 'EX01 picker model returns immutable read data with origin');

const formatted = await registry.invokeProvider('format', { text: 'source' });
assert.equal(formatted.ok, true, 'EX02 formatter provider is arbitrated by capability');
if (formatted.ok) {
  assert.deepEqual(formatted.value.value, { proposed: true });
  assert.equal(formatted.value.origin.providerId, providerId('example.formatter'));
  assert.equal(formatted.value.origin.capability, 'format');
}

const lastGood = registry.snapshot;
const duplicate = await registry.activate(readExampleModule(reads));
assert.deepEqual(duplicate, { ok: false, error: { kind: 'duplicate-module', moduleId: 'example.read' } }, 'failed duplicate activation is diagnosed');
assert.equal(registry.snapshot, lastGood, 'EX05 duplicate activation preserves the exact last-good generation');
assert.equal((await commands.dispatch({ kind: 'command', id: commandId('xi.example.read') }, { value: 'still-good' })).ok, true);

const duplicateCommand = await registry.activate({
  id: 'example.command-collision',
  contractVersion: 1,
  owner: 'tests.t090',
  priority: 1,
  scope: 'feature',
  activate(context) {
    const result = context.registerCommands({
      commands: [defineCommandRegistration<ArgumentsValue, string>({
        descriptor: descriptor('xi.example.read'),
        handler: () => 'replacement',
      })],
    });
    assert.equal(result.ok, true);
  },
});
assert.equal(duplicateCommand.ok, false, 'duplicate command activation fails before publication');
assert.equal(registry.snapshot, lastGood, 'failed command activation retains the last-good registry object');
assert.deepEqual(await commands.dispatch({ kind: 'command', id: commandId('xi.example.read') }, { value: 'after-failure' }), { ok: true, value: 'snapshot-read' });

const conflict = await registry.activate({
  id: 'example.conflict',
  contractVersion: 1,
  owner: 'tests.t090',
  priority: 1,
  scope: 'workspace',
  activate(context) {
    const result = context.registerProvider({
      id: providerId('example.equal-priority'),
      contractVersion: 1,
      owner: 'tests.t090',
      capabilities: ['format'],
      priority: 3,
      scope: 'document',
      provide: () => ({ ok: true, value: { stale: true } }),
    });
    assert.equal(result.ok, false, 'equal-priority provider conflict is rejected before publication');
  },
});
assert.deepEqual(conflict, {
  ok: false,
  error: { kind: 'provider-capability-conflict', capability: 'format', providers: ['example.equal-priority', 'example.formatter'] },
}, 'EX05 equal-priority arbitration conflict keeps the old registry');
assert.equal(registry.snapshot, lastGood);

let slowStarted: (() => void) | undefined;
const slowReady = new Promise<void>((resolve) => { slowStarted = resolve; });
const slow = await registry.activate({
  id: 'example.slow',
  contractVersion: 1,
  owner: 'tests.t090',
  priority: 2,
  scope: 'view',
  activate(context) {
    const result = context.registerProvider({
      id: providerId('example.slow-provider'),
      contractVersion: 1,
      owner: 'tests.t090',
      capabilities: ['slow'],
      priority: 9,
      scope: 'view',
      provide: async (_query, providerContext) => {
        slowStarted?.();
        await new Promise<void>((resolve) => providerContext.cancellation.onCancel(resolve));
        return { ok: true, value: { late: true } };
      },
    });
    assert.equal(result.ok, true);
  },
});
assert.equal(slow.ok, true);
if (!slow.ok) throw new Error('slow activation failed');
const slowInvocation = registry.invokeProvider('slow', { request: 'x' });
await slowReady;
await slow.value.dispose();
assert.deepEqual(await slowInvocation, { ok: false, error: { kind: 'cancelled' } }, 'EX03 late disposed provider cannot publish its result');
assert.equal(registry.inspectProviders('slow').length, 0);

const cancellation = new CancellationSource();
cancellation.cancel();
assert.deepEqual(await registry.invokeProvider('format', { text: 'cancelled' }, { cancellation: cancellation.token }), { ok: false, error: { kind: 'cancelled' } }, 'provider cancellation is reflected before work starts');

await activated.value.dispose();
assert.equal(registry.snapshot.modules.length, 0, 'feature scope disposal unregisters commands, providers and models');
await registry.dispose();
await commands.dispose();

const builtInCommands = new CommandRegistry({ nativeExNames: ['quit'] });
const builtInRegistry = new ContributionRegistry({ commands: builtInCommands, host });
const builtIn = await builtInRegistry.activate(createExampleContributionModule());
assert.equal(builtIn.ok, true, 'EX05 installs the checked-in example module through an explicit composition call');
if (builtIn.ok) {
  assert.deepEqual(await builtInCommands.dispatch({ kind: 'alias', name: 'example-read' }, null), { ok: true, value: 'snapshot-read' });
  assert.equal((await builtInRegistry.readModel('xi.example.picker')).ok, true);
  await builtIn.value.dispose();
}
await builtInRegistry.dispose();
await builtInCommands.dispose();
console.log('T090 contributions passed EX01 command/model, EX02 edit proposal, EX03 cancellation, EX05 atomic activation and disposal fixtures');
