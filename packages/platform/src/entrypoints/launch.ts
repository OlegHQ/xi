/** Small public platform surface used by the standalone launcher. */
export { NodeFilesystemPort } from '../filesystem';
export { NodeProcessPort } from '../process';
export { createNodeClock } from '../clock';
export { installJobControl } from '../job-control';
export type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryEnumerationOptions,
  WorkspaceDirectoryWatchEvent,
  WorkspaceFileEntry,
  WorkspaceFileEnumerationOptions,
  WorkspaceIgnoreOptions,
} from '../filesystem';
export type { PlatformAdapterFactory } from '../index';
export type { PlatformFailure, PlatformPorts, ServiceFactoryContext } from '../../../contracts/src/index.ts';
