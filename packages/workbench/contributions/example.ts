import {
  asIdentifier,
  cloneSerializedSelectionValue,
  type CommandId,
  type CommandSchema,
  type ContributionProvider,
  type ContributionValue,
  type DocumentVersion,
  type FeatureContributionModule,
  type ProviderId,
  type Result,
  type UndoGroupId,
  type Utf16Offset,
  defineCommandRegistration,
} from '../../contracts/src/index';

const valueSchema: CommandSchema<ContributionValue> = {
  decode(input: unknown): Result<ContributionValue, readonly { readonly path: string; readonly code: 'invalid-type' | 'invalid-value' | 'missing-field' | 'unknown-discriminant'; readonly message: string }[]> {
    const result = cloneSerializedSelectionValue(input);
    return result.ok ? result : { ok: false, error: [result.error] };
  },
};

function id<T extends string>(value: string, label: string): T {
  const result = asIdentifier<T>(value, label);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A small built-in module used by architecture and contribution integration tests. */
export function createExampleContributionModule(): FeatureContributionModule {
  return {
    id: 'xi.example',
    contractVersion: 1,
    owner: 'workbench.example',
    priority: 0,
    scope: 'workspace',
    activate(context) {
      const command = defineCommandRegistration<ContributionValue, ContributionValue>({
        descriptor: {
          id: id<CommandId>('xi.example.read', 'commandId'),
          contractVersion: 1,
          owner: 'workbench.example',
          title: 'Read contribution snapshot',
          help: 'Read the immutable workbench snapshot through the contribution port.',
          category: 'example',
          arguments: valueSchema,
          output: valueSchema,
          selectionPolicy: 'workspace-once',
          effect: 'read',
          undoPolicy: 'none',
          replayPolicy: 'never',
          cancellationPolicy: 'cancellable',
          availability: {
            contexts: [],
            requiredCapabilities: [],
            unavailableReason: 'The example command is unavailable.',
          },
        },
        handler: (_input, invocation) => invocation.cancellation.isCancelled ? null : context.read.read(),
      });
      const commandResult = context.registerCommands({
        commands: [command],
        aliases: [{ name: 'example-read', target: { kind: 'command', id: id<CommandId>('xi.example.read', 'commandId') } }],
      });
      if (!commandResult.ok) return;

      const modelResult = context.registerModel({
        id: 'xi.example.picker',
        contractVersion: 1,
        owner: 'workbench.example',
        kind: 'picker',
        priority: 0,
        scope: 'workspace',
        read: (modelContext) => ({
          title: 'Example',
          snapshot: modelContext.read.read(),
          selectionGeneration: Number(modelContext.selectionGeneration),
        }),
      });
      if (!modelResult.ok) return;

      const provider: ContributionProvider = {
        id: id<ProviderId>('xi.example.edit', 'providerId'),
        contractVersion: 1,
        owner: 'workbench.example',
        capabilities: ['example.edit'],
        priority: 0,
        scope: 'document',
        provide: async (_query, providerContext) => {
          if (providerContext.edit === undefined) {
            return { ok: false, error: { kind: 'unavailable', message: 'the edit proposal port is unavailable' } };
          }
          const version = readVersion(providerContext.read.read());
          if (version === undefined) {
            return { ok: false, error: { kind: 'unavailable', message: 'the read snapshot has no document version' } };
          }
          const proposal = await providerContext.edit.propose({
            expectedVersion: version,
            edits: [{ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: '' }],
            origin: 'xi.example.edit',
            undoGroup: 'xi-example-edit' as UndoGroupId,
          }, providerContext.cancellation);
          return { ok: true, value: { proposed: proposal.ok } };
        },
      };
      context.registerProvider(provider);
    },
  };
}

function readVersion(value: ContributionValue): DocumentVersion | undefined {
  if (value === null || typeof value !== 'object' || !('version' in value)) return undefined;
  const version = value.version;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? version as DocumentVersion
    : undefined;
}
