import assert from 'node:assert/strict';
import {
  acceptExCompletion,
  buildExCommandLineReadModel,
  CommandRegistry,
  DEFAULT_NATIVE_EX_COMMANDS,
  registerNativeSafeAliases,
  resolveExExecution,
  validateNativeSafeAliases,
} from '../../packages/workbench/src/index';
import { ExCommandLineSession } from '../../packages/workbench/commands/ex-command-line';
import {
  defineCommandRegistration,
  type CommandDescriptorCandidate,
  type CommandSchema,
} from '../../packages/contracts/src/index';
import { asIdentifier, type CommandId, type Result, type ValidationIssue } from '../../packages/primitives/src/index';
import { formatExCommandLineLines } from '../../packages/ui/commandline/index';

const emptySchema: CommandSchema<null> = {
  decode(input: unknown): Result<null, readonly ValidationIssue[]> {
    return input === null || input === undefined ? { ok: true, value: null } : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected null' }] };
  },
};
const outputSchema: CommandSchema<string> = {
  decode(input: unknown): Result<string, readonly ValidationIssue[]> {
    return typeof input === 'string' ? { ok: true, value: input } : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'expected text' }] };
  },
};
function id(value: string): CommandId {
  const checked = asIdentifier<CommandId>(value, 'commandId');
  if (!checked.ok) throw new Error(checked.error.message);
  return checked.value;
}
function command(value: string, requiredCapabilities: readonly string[] = []) {
  const descriptor: CommandDescriptorCandidate<null, string> = {
    id: id(value), contractVersion: 1, owner: 't083.fixture', title: value, help: `${value} help`, category: 'fixture',
    arguments: emptySchema, output: outputSchema, selectionPolicy: 'document-once', effect: 'read', undoPolicy: 'none', replayPolicy: 'never', cancellationPolicy: 'non-cancellable',
    availability: { contexts: [], requiredCapabilities, unavailableReason: 'Requires the fixture capability.' },
  };
  return defineCommandRegistration({ descriptor, handler: () => value });
}

const registry = new CommandRegistry({ nativeExNames: DEFAULT_NATIVE_EX_COMMANDS.map((entry) => entry.name) });
const registered = registry.register({ commands: [command('xi.buffer.next'), command('xi.theme.pick', ['workspace.write'])] });
assert.equal(registered.ok, true, 'T083-REG-01 Xi commands register in the T074 registry');
const aliases = registerNativeSafeAliases(registry, [{ name: 'theme', target: id('xi.theme.pick') }]);
assert.equal(aliases.ok, true, 'T083-ALIAS-01 friendly aliases register only through the command registry');

const quitModel = buildExCommandLineReadModel({ source: ':q', registry }, 99);
assert.equal(quitModel.position.typedName, 'q', 'E20-CONTEXT-01 command position retains the typed native abbreviation');
assert.equal(quitModel.position.rangeStart, 1, 'E20-CONTEXT-02 range metadata starts after the command prefix');
assert.equal(quitModel.acceptanceHint, 'Enter: execute · Tab: complete · Esc: cancel', 'E20-HINT-01 completion acceptance is visible before execution');
assert.equal(quitModel.canExecute, true, 'E20-EXECUTE-01 typed :q is executable');
assert.equal(quitModel.execution?.kind, 'native-close', 'E20-EXECUTE-02 :q keeps native close semantics');
if (quitModel.execution?.kind === 'native-close') assert.equal(quitModel.execution.bang, false, 'E20-EXECUTE-03 :q does not gain an automatic bang');

const tabbed = quitModel.candidates.find((candidate) => candidate.label === 'quit');
assert.notEqual(tabbed, undefined, 'E20-TAB-01 :q exposes the canonical quit completion');
if (tabbed !== undefined) assert.equal(acceptExCompletion(':q', tabbed), ':quit', 'E20-TAB-02 Tab acceptance visibly replaces :q');
const session = new ExCommandLineSession({ registry, source: ':q' });
session.moveSelection(1);
const typedQuit = session.handleInput({ kind: 'key', key: 'Enter' });
assert.equal(typedQuit.kind, 'execute', 'E20-ENTER-01 Enter executes typed :q even when a suggestion row was moved');
if (typedQuit.kind === 'execute') {
  assert.equal(typedQuit.source, ':q', 'E20-ENTER-02 highlighted completion does not rewrite typed source');
  assert.equal(typedQuit.execution.kind, 'native-close', 'E20-ENTER-03 highlighted completion cannot redirect native close');
}
session.setSource(':q');
const accepted = session.handleInput({ kind: 'key', key: 'Tab' });
assert.equal(accepted.kind, 'completion-accepted', 'E20-TAB-03 Tab reports a visible acceptance event');
assert.equal(session.source, ':quit', 'E20-TAB-04 accepted source is visible before a later Enter');
const acceptedQuit = session.handleInput({ kind: 'key', key: 'Enter' });
assert.equal(acceptedQuit.kind, 'execute', 'E20-TAB-05 Enter executes only after visible completion replacement');

for (const [source, expected] of [[':w', 'native-write'], [':wq', 'native-write-close'], [':x', 'native-x'], [':qa', 'native-quit-all'], [':wa', 'native-write-all'], [':write', 'native-write']] as const) {
  const result = resolveExExecution(source, registry);
  assert.equal(result.ok, true, `EX04-NATIVE-${source} resolves`);
  if (result.ok) assert.equal(result.value.kind, expected, `EX04-NATIVE-${source} retains native scope`);
}
const ranged = buildExCommandLineReadModel({ source: ':%write target.txt', registry });
assert.equal(ranged.position.rangeStart, 1, 'EX04-RANGE-01 range position remains visible to completion');
assert.equal(ranged.position.commandNameStart, 2, 'EX04-RANGE-02 command position follows % range');
assert.equal(ranged.parsed?.name, 'write', 'EX04-RANGE-03 complete native range remains parser-owned');
const separated = buildExCommandLineReadModel({ source: ':s/foo|bar/baz/|q', registry });
assert.equal(separated.position.typedName, 'q', 'EX04-SEPARATOR-01 pipe inside substitute pattern does not steal active command context');
assert.equal(separated.position.segmentStart, 16, 'EX04-SEPARATOR-02 active segment begins after the unescaped command separator');
const escapedPath = buildExCommandLineReadModel({ source: ':edit foo\\|bar|q', registry });
assert.equal(escapedPath.position.typedName, 'q', 'EX04-PATH-01 escaped path separator remains argument text');

const aliasModel = buildExCommandLineReadModel({ source: ':theme', registry, availability: { contexts: [], capabilities: [] } });
assert.equal(aliasModel.candidates.some((candidate) => candidate.kind === 'alias' && candidate.exact), true, 'EX04-ALIAS-01 exact friendly alias is discoverable');
assert.equal(aliasModel.candidates.find((candidate) => candidate.kind === 'alias')?.available, false, 'EX04-ALIAS-02 unavailable capability remains visible');
const aliasResult = resolveExExecution(':theme', registry, { availability: { contexts: [], capabilities: ['workspace.write'] } });
assert.equal(aliasResult.ok, true, 'EX04-ALIAS-03 exact alias resolves only with its capability');
if (aliasResult.ok) assert.equal(aliasResult.value.kind, 'xi-alias', 'EX04-ALIAS-04 alias retains Xi origin');

const beforeCollision = registry.snapshot;
const collision = validateNativeSafeAliases([{ name: 'q', target: id('xi.buffer.next') }], registry.snapshot);
assert.equal(collision.ok, false, 'EX04-COLLISION-01 Helix-style short alias is rejected against native q');
assert.equal(registry.snapshot, beforeCollision, 'EX04-COLLISION-02 rejected alias leaves the last-good registry untouched');
const cycle = registry.register({ commands: [], aliases: [{ name: 'one', target: { kind: 'alias', name: 'two' } }, { name: 'two', target: { kind: 'alias', name: 'one' } }] });
assert.equal(cycle.ok, false, 'EX04-CYCLE-01 alias cycles are rejected');
assert.equal(registry.snapshot, beforeCollision, 'EX04-CYCLE-02 alias-cycle rejection preserves last-good generation');

const rows = formatExCommandLineLines(quitModel, 44, 3);
assert.equal(rows[1], quitModel.acceptanceHint, 'E20-RENDER-01 command-line rows expose Tab acceptance text');
assert.ok(rows.every((row) => row.length <= 44), 'E20-RENDER-02 command-line rows remain bounded');
session.dispose();
void registry.dispose();
console.log('T083 Ex discovery passed E20 typed-enter semantics, visible Tab acceptance, native q/wq/x/qa/wa scope, range/separator/path context, unavailable aliases, collision/cycle rollback and bounded command-line rows');
