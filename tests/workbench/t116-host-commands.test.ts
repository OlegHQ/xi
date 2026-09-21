import { strict as assert } from 'node:assert';
import {
  WorkbenchHostCommands,
  type HostCommandsProblemsPort,
  type HostCommandsSaveCoordinatorPort,
  type HostCommandsWorkspaceEditsPort,
} from '../../packages/workbench/commands/host-commands';

const noopWorkspaceEdits: HostCommandsWorkspaceEditsPort = { renameCurrent: async () => true, requestCodeActions: async () => true };
const noopProblems: HostCommandsProblemsPort = { runConfiguredTask: async () => {}, runShellCommand: async () => {}, listConfiguredTasks: async () => {}, cancelTask: async () => {} };

// T116-HOST-01: `:wa` with a dirty buffer that has never been saved (no path) reports
// "no file name" through the injected `onError` port and counts it as a failure --
// byte-identical to the original main.ts `handleWorkbenchCommand`'s `wa`/`wa!` branch.
{
  const errors: string[] = [];
  const markers: { readonly name: string; readonly payload?: unknown }[] = [];
  const saveCoordinator: HostCommandsSaveCoordinatorPort = {
    requestSave: async () => true,
    formatView: async () => true,
  };
  const dirtyBuffer = { dirty: true, path: undefined, documentId: 'doc-1', viewIds: ['view-1'] };
  const savedBuffer = { dirty: true, path: '/workspace/saved.txt', documentId: 'doc-2', viewIds: ['view-2'] };
  const session = {
    buffers: () => [dirtyBuffer, savedBuffer],
    views: () => [],
    buffer: () => undefined,
  };
  const host = {
    documents: new Map([['doc-2', {}]]),
    sessions: new Map(),
  };
  const commands = new WorkbenchHostCommands({
    host: host as never,
    session: session as never,
    filesystem: { stat: async () => ({ ok: false, error: { kind: 'not-found' } }), resolvePath: (base: string, relative: string) => `${base}/${relative}`, directoryPath: (path: string) => path } as never,
    marker: (name, payload) => { markers.push({ name, payload }); },
    onError: (message) => { errors.push(message); },
    workspaceRoot: '/workspace',
    workspacePathFromUri: () => undefined,
    ensureHostNavigation: async () => {},
    readHostNavigation: () => undefined,
    workspaceEdits: noopWorkspaceEdits,
    problems: noopProblems,
    saveCoordinator,
    directoryDrafts: { open: async () => {} },
  });

  const result = await commands.handleWorkbenchCommand('wa', 'view-1' as never);
  assert.equal(result, 'handled');
  assert.ok(errors.includes('xi: no file name\n'), 'T116-HOST-01a the pathless buffer reported "no file name"');
  assert.ok(errors.some((message) => message.includes('failed to save 1 of 2')), 'T116-HOST-01b exactly one of the two buffers failed');
  const writeAllMarker = markers.find((entry) => entry.name === 'XI_WORKBENCH_WRITE_ALL');
  assert.deepEqual(writeAllMarker?.payload, { saved: 1, failed: 1 }, 'T116-HOST-01c the marker payload counts saved vs failed');
}

console.log('T116 WorkbenchHostCommands passed the wa-no-file-name fixture');
