/** Mirrors `packages/services/files/directory-draft`'s `DirectoryOperation`/`DirectoryOperationPlan`
 * shapes structurally -- workbench cannot import `packages/services`, not even types. */
export type ExplorerDirectoryOperation =
  | { readonly kind: 'create'; readonly rowId: string; readonly sourcePath: string; readonly destinationPath: string; readonly directory: boolean }
  | { readonly kind: 'rename'; readonly rowId: string; readonly sourceId: string; readonly from: string; readonly to: string; readonly sourcePath: string; readonly destinationPath: string }
  | { readonly kind: 'trash'; readonly rowId: string; readonly sourceId: string; readonly sourcePath: string }
  | { readonly kind: 'copy'; readonly rowId: string; readonly sourceId: string; readonly sourcePath: string; readonly destinationPath: string };

export interface ExplorerDirectoryOperationPlan {
  readonly contractVersion: 1;
  readonly directoryPath: string;
  readonly baseGeneration: number;
  readonly operations: readonly ExplorerDirectoryOperation[];
}
