import {
  asIdentifier,
  type CancellationToken,
  type CommandId,
  type Result,
  type ValidationIssue,
} from '../../../packages/primitives/src/index';
import {
  defineCommandRegistration,
  type CommandAlias,
  type CommandAvailabilityContext,
  type CommandDescriptorCandidate,
  type CommandSchema,
  type TypedCommandRegistration,
} from '../../../packages/contracts/src/index';
import { buildNativeExReservations, CommandRegistry } from '../../../packages/workbench/src/index';

type TestBody = () => void | Promise<void>;
const testCases: { readonly name: string; readonly body: TestBody }[] = [];

function describe(_name: string, body: () => void): void {
  body();
}

function test(name: string, body: TestBody): void {
  testCases.push({ name, body });
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown): void {
      if (!Object.is(actual, expected)) throw new Error(`expected ${String(actual)} to be ${String(expected)}`);
    },
    toBeUndefined(): void {
      if (actual !== undefined) throw new Error(`expected ${String(actual)} to be undefined`);
    },
    toEqual(expected: unknown): void {
      if (!deepEqual(actual, expected)) throw new Error(`expected ${render(actual)} to equal ${render(expected)}`);
    },
    toMatchObject(expected: unknown): void {
      if (!matchesObject(actual, expected)) throw new Error(`expected ${render(actual)} to match ${render(expected)}`);
    },
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => matchesObject(actual[index], value));
  }
  if (Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  return Object.keys(expectedRecord).every((key) => matchesObject(actualRecord[key], expectedRecord[key]));
}

function render(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

interface ArgumentsValue {
  readonly value: string;
}

const argumentsSchema: CommandSchema<ArgumentsValue> = {
  decode(input: unknown): Result<ArgumentsValue, readonly ValidationIssue[]> {
    if (input === null || typeof input !== 'object' || !('value' in input) || typeof input.value !== 'string') {
      return { ok: false, error: [{ path: '$.value', code: 'invalid-type', message: 'value must be a string' }] };
    }
    return { ok: true, value: { value: input.value } };
  },
};

const stringSchema: CommandSchema<string> = {
  decode(input: unknown): Result<string, readonly ValidationIssue[]> {
    return typeof input === 'string'
      ? { ok: true, value: input }
      : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'result must be a string' }] };
  },
};

const availability: CommandDescriptorCandidate<ArgumentsValue, string>['availability'] = {
  contexts: [],
  requiredCapabilities: [],
  unavailableReason: 'Command is unavailable in this context.',
};

function id(value: string): CommandId {
  const result = asIdentifier<CommandId>(value, 'commandId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function descriptor(
  commandId: string,
  overrides: Partial<CommandDescriptorCandidate<ArgumentsValue, string>> = {},
): CommandDescriptorCandidate<ArgumentsValue, string> {
  return {
    id: id(commandId),
    contractVersion: 1,
    owner: 'test.commands',
    title: 'Read value',
    help: 'Read one value.',
    category: 'test',
    arguments: argumentsSchema,
    output: stringSchema,
    selectionPolicy: 'document-once',
    effect: 'read',
    undoPolicy: 'none',
    replayPolicy: 'never',
    cancellationPolicy: 'cancellable',
    availability,
    ...overrides,
  };
}

function registration(
  commandId: string,
  handler: (input: ArgumentsValue, context: { readonly cancellation: CancellationToken; readonly registryGeneration: number; readonly availability: CommandAvailabilityContext }) => string | Promise<string>,
  overrides: Partial<CommandDescriptorCandidate<ArgumentsValue, string>> = {},
) {
  const typed: TypedCommandRegistration<ArgumentsValue, string> = {
    descriptor: descriptor(commandId, overrides),
    handler,
  };
  return defineCommandRegistration(typed);
}

function alias(name: string, target: CommandId | string, targetKind: 'command' | 'alias' = 'command'): CommandAlias {
  return {
    name,
    target: targetKind === 'command'
      ? { kind: 'command', id: target as CommandId }
      : { kind: 'alias', name: target },
  };
}

function expectFailure<T, E>(result: Result<T, E>): E {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  return result.error;
}

describe('atomic command registry', () => {
  test('[EX01] inspection, alias dispatch, and handler share one descriptor and execute once', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    let calls = 0;
    const registered = registry.register({
      commands: [registration('xi.test.read', ({ value }) => { calls += 1; return value.toUpperCase(); })],
      aliases: [alias('read-value', id('xi.test.read'))],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const inspection = registry.inspect({ kind: 'alias', name: 'read-value' });
    expect(inspection?.descriptor).toBe(registry.snapshot.commands[0]?.descriptor);
    expect(inspection?.alias?.name).toBe('read-value');
    expect(Object.isFrozen(registry.snapshot)).toBe(true);
    expect(Object.isFrozen(registry.snapshot.commands)).toBe(true);

    const output = await registry.dispatch({ kind: 'alias', name: 'read-value' }, { value: 'ok' });
    expect(output).toEqual({ ok: true, value: 'OK' });
    expect(calls).toBe(1);
    await registry.dispose();
  });

  test('[EX01] invalid argument data is rejected before the registered handler runs', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    let calls = 0;
    const result = registry.register({ commands: [registration('xi.test.validate', () => { calls += 1; return 'unexpected'; })] });
    expect(result.ok).toBe(true);

    const dispatch = await registry.dispatch({ kind: 'command', id: id('xi.test.validate') }, { value: 3 });
    expect(dispatch).toMatchObject({ ok: false, error: { kind: 'invalid-arguments' } });
    expect(calls).toBe(0);
    await registry.dispose();
  });

  test('published descriptors keep captured decoders immutable across registration changes', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    const mutableSchema: CommandSchema<ArgumentsValue> = { decode: argumentsSchema.decode };
    const command = defineCommandRegistration<ArgumentsValue, string>({
      descriptor: descriptor('xi.test.immutable-schema', { arguments: mutableSchema }),
      handler: ({ value }) => value,
    });
    const registered = registry.register({ commands: [command] });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    mutableSchema.decode = () => ({ ok: false, error: [{ path: '$', code: 'invalid-value', message: 'mutated' }] });

    const inspected = registry.inspect({ kind: 'command', id: id('xi.test.immutable-schema') });
    expect(Object.isFrozen(inspected?.descriptor.arguments)).toBe(true);
    expect(await registry.dispatch({ kind: 'command', id: id('xi.test.immutable-schema') }, { value: 'captured' }))
      .toEqual({ ok: true, value: 'captured' });
    await registry.dispose();
  });

  test('failed candidates preserve the exact last-good generation', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    const original = registry.register({ commands: [registration('xi.test.stable', ({ value }) => value)] });
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const lastGood = registry.snapshot;

    const missingPolicyDescriptor = descriptor('xi.test.missing-policy');
    const { selectionPolicy: _omitted, ...withoutPolicy } = missingPolicyDescriptor;
    void _omitted;
    const missingPolicy = registry.register({
      commands: [defineCommandRegistration<ArgumentsValue, string>({
        descriptor: withoutPolicy,
        handler: () => 'bad',
      })],
    });
    expect(expectFailure(missingPolicy)).toMatchObject({ kind: 'missing-selection-policy' });
    expect(registry.snapshot).toBe(lastGood);

    const duplicate = registry.register({ commands: [registration('xi.test.stable', () => 'duplicate')] });
    expect(expectFailure(duplicate)).toMatchObject({ kind: 'duplicate-command-id' });
    expect(registry.snapshot).toBe(lastGood);

    const cycle = registry.register({
      aliases: [alias('one', 'two', 'alias'), alias('two', 'one', 'alias')],
      commands: [],
    });
    expect(expectFailure(cycle)).toMatchObject({ kind: 'alias-cycle' });
    expect(registry.snapshot).toBe(lastGood);

    const collision = registry.register({
      aliases: [alias('qu', id('xi.test.stable'))],
      commands: [],
    });
    expect(expectFailure(collision)).toMatchObject({ kind: 'native-ex-collision' });
    expect(registry.snapshot).toBe(lastGood);

    const stillGood = await registry.dispatch({ kind: 'command', id: id('xi.test.stable') }, { value: 'available' });
    expect(stillGood).toEqual({ ok: true, value: 'available' });
    await registry.dispose();
    original.value.dispose();
  });

  test('duplicate aliases are rejected as ambiguous without changing the published snapshot', () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    const base = registry.register({ commands: [registration('xi.test.alias', () => 'ok')] });
    expect(base.ok).toBe(true);
    const lastGood = registry.snapshot;
    const result = registry.registerBatch([
      { aliases: [alias('show', id('xi.test.alias'))], commands: [] },
      { aliases: [alias('show', id('xi.test.alias'))], commands: [] },
    ]);
    expect(expectFailure(result)).toMatchObject({ kind: 'duplicate-alias' });
    expect(registry.snapshot).toBe(lastGood);
  });

  test('availability exposes a disabled reason and blocks dispatch', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    let calls = 0;
    const result = registry.register({
      commands: [registration('xi.test.capability', () => { calls += 1; return 'ok'; }, {
        availability: {
          contexts: ['editor'],
          requiredCapabilities: ['workspace.write'],
          unavailableReason: 'Requires an editable workspace.',
        },
      })],
    });
    expect(result.ok).toBe(true);

    const context: CommandAvailabilityContext = { contexts: ['editor'], capabilities: [] };
    expect(registry.inspect({ kind: 'command', id: id('xi.test.capability') }, context)).toMatchObject({
      available: false,
      disabledReason: 'Requires an editable workspace.',
    });
    const output = await registry.dispatch({ kind: 'command', id: id('xi.test.capability') }, { value: 'x' }, { availability: context });
    expect(output).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(calls).toBe(0);
    await registry.dispose();
  });

  test('[EX04] IDs stay stable across label changes and invocation captures its registry generation', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    let resolvePending: ((value: string) => void) | undefined;
    let capturedGeneration = 0;
    const firstRegistration = registry.register({
      commands: [registration('xi.test.rename-label', (_input, context) => {
        capturedGeneration = context.registryGeneration;
        return new Promise<string>((resolve) => { resolvePending = resolve; });
      })],
    });
    expect(firstRegistration.ok).toBe(true);
    if (!firstRegistration.ok) return;
    const firstDescriptor = registry.snapshot.commands[0]?.descriptor;
    const invocation = registry.dispatch({ kind: 'command', id: id('xi.test.rename-label') }, { value: 'x' });
    await Promise.resolve();

    const added = registry.register({ commands: [registration('xi.test.other', ({ value }) => value)] });
    expect(added.ok).toBe(true);
    const publishedGeneration = registry.snapshot.generation;
    expect(capturedGeneration).toBe(1);
    expect(publishedGeneration).toBe(2);
    resolvePending?.('done');
    expect(await invocation).toEqual({ ok: true, value: 'done' });

    firstRegistration.value.dispose();
    const relabeled = registry.register({ commands: [registration('xi.test.rename-label', ({ value }) => value, { title: 'A new label' })] });
    expect(relabeled.ok).toBe(true);
    const secondDescriptor = registry.snapshot.commands.find((row) => row.descriptor.id === id('xi.test.rename-label'))?.descriptor;
    expect(firstDescriptor?.id).toBe(secondDescriptor?.id);
    expect(firstDescriptor?.title).toBe('Read value');
    expect(secondDescriptor?.title).toBe('A new label');
    await registry.dispose();
  });

  test('disposing the provider cancels an in-flight invocation and suppresses its result', async () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolvePending: ((value: string) => void) | undefined;
    let capturedCancellation: CancellationToken | undefined;
    const registered = registry.register({
      commands: [registration('xi.test.slow-provider', (_input, context) => {
        capturedCancellation = context.cancellation;
        markStarted?.();
        return new Promise<string>((resolve) => { resolvePending = resolve; });
      })],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const inFlight = registry.dispatch({ kind: 'command', id: id('xi.test.slow-provider') }, { value: 'x' });
    await started;
    registered.value.dispose();
    expect(capturedCancellation?.isCancelled).toBe(true);
    expect(await inFlight).toEqual({ ok: false, error: { kind: 'cancelled' } });
    resolvePending?.('stale result');
    expect(registry.inspect({ kind: 'command', id: id('xi.test.slow-provider') })).toBeUndefined();
    await registry.dispose();
  });

  test('command ordering is stable by declared priority, then command ID', () => {
    const registry = new CommandRegistry({ nativeExNames: ['quit'] });
    const result = registry.registerBatch([
      { commands: [registration('xi.test.zed', () => 'z', { priority: 5 })] },
      { commands: [registration('xi.test.alpha', () => 'a', { priority: 5 })] },
      { commands: [registration('xi.test.low', () => 'l', { priority: -1 })] },
    ]);
    expect(result.ok).toBe(true);
    expect(registry.snapshot.commands.map((row) => row.descriptor.id)).toEqual([
      id('xi.test.alpha'), id('xi.test.zed'), id('xi.test.low'),
    ]);
  });

  test('native command inventory is required before aliases can be registered', () => {
    let rejected = false;
    try {
      new CommandRegistry({ nativeExNames: [] });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test('native Ex exact names stay reserved even when they prefix another command', () => {
    const reservations = buildNativeExReservations(['w', 'write']);
    expect(reservations.find((item) => item.name === 'w')?.reservedAs).toEqual(['w']);
    const registry = new CommandRegistry({ nativeExNames: ['w', 'write'] });
    const command = registry.register({ commands: [registration('xi.test.native-short', () => 'ok')] });
    expect(command.ok).toBe(true);
    const colliding = registry.register({ aliases: [alias('w', id('xi.test.native-short'))], commands: [] });
    expect(expectFailure(colliding)).toMatchObject({ kind: 'native-ex-collision' });
  });
});

for (const testCase of testCases) {
  await testCase.body();
  console.log(`PASS ${testCase.name}`);
}
console.log(`Command registry: ${testCases.length} checks passed.`);
