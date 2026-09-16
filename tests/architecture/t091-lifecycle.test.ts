import assert from 'node:assert/strict';
import { CommandRegistry, ContributionRegistry, createExampleContributionModule, DEFAULT_NATIVE_EX_COMMANDS } from '../../packages/workbench/src/index';
import type { ContributionRegistryHost, SelectionGeneration } from '../../packages/contracts/src/index';
import { encodeSession, decodeSession } from '../../packages/services/persistence/index';

const host: ContributionRegistryHost = { read: { read: () => null }, selectionGeneration: 0 as SelectionGeneration };
const registry = new ContributionRegistry({ commands: new CommandRegistry({ nativeExNames: DEFAULT_NATIVE_EX_COMMANDS.map((item) => item.name) }), host });
for (let index = 0; index < 1_000; index += 1) { const activation = await registry.activate(createExampleContributionModule()); assert.equal(activation.ok, true); if (activation.ok) await activation.value.dispose(); }
assert.equal(registry.snapshot.modules.length, 0, 'EX02-RETENTION-01 disposed contribution cycles release registrations');
const session = encodeSession({ schemaVersion: 1, workspaceId: 'w', roots: ['/repo'], documents: [] }); assert.equal(session.ok, true); if (session.ok) assert.equal(decodeSession(session.value).ok, true, 'EX05-MIGRATION-01 current schema decodes');
const unknown = decodeSession(new TextEncoder().encode('{"schemaVersion":99,"workspaceId":"w","roots":[],"documents":[]}')); assert.equal(unknown.ok, false, 'EX05-FUTURE-01 unknown future schema is retained as an explicit failure');
registry.dispose();
console.log('T091 contribution lifecycle passed 1000 activation/disposal cycles, registration cleanup and schema evolution rejection');
