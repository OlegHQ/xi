import type { DisposableScope } from '../../primitives/src/index.ts';
import type { PlatformPorts } from '../../contracts/src/index.ts';

export { NodeFilesystemPort, xiConfigDirectory, xiRecoveryStateDirectory, xiRecoveryJournalPath, xiJumpHistoryPath } from './filesystem';
export type { WorkspaceDirectoryEntry, WorkspaceDirectoryEnumerationOptions, WorkspaceDirectoryWatchEvent, WorkspaceFileEntry, WorkspaceFileEnumerationOptions, WorkspaceIgnoreOptions } from './filesystem';
export { NodeProcessPort } from './process';
export { createNodeClock } from './clock';
export { installJobControl } from './job-control';

/** OS adapters are constructed only at the composition root. */
export interface PlatformAdapterFactory {
  create(scope: DisposableScope): Promise<PlatformPorts>;
}

export type { ClipboardPort, ClockPort, FilesystemPort, ProcessPort, ProcessHandle, PlatformFailure, PlatformPorts } from '../../contracts/src/index.ts';
