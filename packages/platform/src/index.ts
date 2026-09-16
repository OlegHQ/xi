import type { DisposableScope } from '../../primitives/src/index.ts';
import type { PlatformPorts } from '../../contracts/src/index.ts';

export { NodeFilesystemPort } from './filesystem';
export type { WorkspaceDirectoryEntry, WorkspaceDirectoryWatchEvent, WorkspaceFileEntry, WorkspaceFileEnumerationOptions } from './filesystem';
export { NodeProcessPort } from './process';

/** OS adapters are constructed only at the composition root. */
export interface PlatformAdapterFactory {
  create(scope: DisposableScope): Promise<PlatformPorts>;
}

export type { ClipboardPort, ClockPort, FilesystemPort, ProcessPort, ProcessHandle, PlatformFailure, PlatformPorts } from '../../contracts/src/index.ts';
