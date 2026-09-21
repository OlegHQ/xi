import type {
  CancellationToken,
  CommandId,
  Disposable,
  DisposableScope,
  DocumentId,
  DocumentVersion,
  ProviderId,
  RequestId,
  Result,
  ValidationIssue,
} from '../../primitives/src/index.ts';
import type { CommandEffect, SelectionPolicy } from './commands.ts';

export type {
  CommandAlias,
  CommandAliasTarget,
  CommandAvailabilityContext,
  CommandAvailabilityPolicy,
  CommandCancellationPolicy,
  CommandContributionSet,
  CommandDescriptor,
  CommandDescriptorCandidate,
  CommandDispatchFailure,
  CommandDispatchResult,
  CommandEffect,
  CommandHandler,
  CommandInspection,
  CommandInvocationContext,
  CommandInvocationRef,
  CommandRegistration,
  CommandRegistryFailure,
  CommandRegistrySnapshot,
  CommandReplayPolicy,
  CommandSchema,
  CommandUndoPolicy,
  NativeExReservation,
  RegisteredCommandDescriptor,
  SelectionPolicy,
  TypedCommandRegistration,
} from './commands.ts';
export { defineCommandRegistration } from './commands';
export type {
  ContributionEditFailure,
  ContributionEditPort,
  ContributionEditProposal,
  ContributionEditResult,
  ContributionInvocationContext,
  ContributionInvocationFailure,
  ContributionInvocationResult,
  ContributionModelContext,
  ContributionModuleContext,
  ContributionOrigin,
  ContributionProvider,
  ContributionProviderFailure,
  ContributionProviderInspection,
  ContributionReadModel,
  ContributionReadPort,
  ContributionRegistryHost,
  ContributionRegistrySnapshot,
  ContributionRegistrationFailure,
  ContributionScope,
  ContributionTextEdit,
  ContributionValue,
  FeatureContributionModule,
} from './contributions.ts';
export type {
  ResourceAdmissionFailure,
  ResourceKind,
  ResourceLease,
  ResourceOwnerStats,
  ResourcePriority,
  ResourceRequest,
  ResourceStats,
} from './resources.ts';
export { CancellationSource, DisposableScope } from '../../primitives/src/index';
export { asCellColumn, asIdentifier, asLineIndex, asUtf16Offset, cloneSerializedSelectionValue } from '../../primitives/src/index';

export interface Decoder<T> {
  decode(input: unknown): Result<T, readonly ValidationIssue[]>;
}

export type BoundaryDecodeFailure =
  | { readonly kind: 'invalid-utf8'; readonly message: string }
  | { readonly kind: 'invalid-json'; readonly message: string }
  | { readonly kind: 'schema'; readonly issues: readonly ValidationIssue[] };

/** Decode external JSON as unknown, then require an owner-provided schema. */
export const decodeJsonAtBoundary = <T>(bytes: Uint8Array, decoder: Decoder<T>): Result<T, BoundaryDecodeFailure> => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: { kind: 'invalid-utf8', message: 'input is not valid UTF-8' } };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: { kind: 'invalid-json', message: 'input is not valid JSON' } };
  }

  const decoded = decoder.decode(value);
  return decoded.ok
    ? decoded
    : { ok: false, error: { kind: 'schema', issues: decoded.error } };
};

export interface PlatformFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProcessSpec {
  readonly argv: readonly [executable: string, ...arguments_: string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Search and other one-way commands can avoid allocating a writable stdin pipe. */
  readonly stdin?: 'pipe' | 'ignore';
  /** Wall-clock lifetime bound; omit for a long-lived process (e.g. a language server) with no forced lifetime. */
  readonly timeoutMilliseconds?: number;
  readonly cancellation: CancellationToken;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ProcessInput extends Disposable {
  write(bytes: Uint8Array): Promise<Result<void, PlatformFailure>>;
  close(): Promise<Result<void, PlatformFailure>>;
}

export interface ProcessHandle extends Disposable {
  readonly stdin: ProcessInput | null;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exit: Promise<Result<ProcessExit, PlatformFailure>>;
  terminate(forceAfterMilliseconds: number): Promise<void>;
}

/** Implementations supply argv arrays and async streams; they never accept shell text. */
export interface ProcessPort {
  spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>>;
}

export interface FileInfo {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly sizeBytes: number;
  readonly modifiedMilliseconds: number;
  /** Stable identity when the platform can provide it; never used as a path identity. */
  readonly device?: string;
  readonly inode?: string;
  /** Number of directory entries referring to this inode, when available. */
  readonly linkCount?: number;
}

export type FileWatchEvent =
  | { readonly kind: 'created' | 'changed' | 'removed'; readonly path: string }
  | { readonly kind: 'overflow'; readonly path: string };

export interface ReadFileOptions {
  /** When the file's size (from a stat taken before reading) exceeds this, the read fails with
   * `{ code: 'file-too-large' }` instead of materializing the whole file. */
  readonly maxBytes?: number;
}

/** Asynchronous filesystem access. Platform adapters normalize OS failures. */
export interface FilesystemPort {
  readFile(path: string, cancellation: CancellationToken, options?: ReadFileOptions): Promise<Result<Uint8Array, PlatformFailure>>;
  /** Optional bounded reader; chunks are ordered and must not be mutated by the consumer. */
  readFileChunks?(path: string, cancellation: CancellationToken): Promise<Result<AsyncIterable<Uint8Array>, PlatformFailure>>;
  /** Direct write for callers that explicitly opt out of atomic replacement. */
  writeFile?(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  /** Optional bounded writer; implementations must retain atomic rename and cleanup semantics. */
  writeFileAtomicChunks?(path: string, contents: AsyncIterable<Uint8Array>, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  stat(path: string, cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>>;
  watch(path: string, listener: (event: FileWatchEvent) => void, cancellation: CancellationToken): Promise<Result<Disposable, PlatformFailure>>;
}

export interface ClockPort {
  monotonicMilliseconds(): number;
  schedule(delayMilliseconds: number, callback: () => void): Disposable;
  sleep(delayMilliseconds: number, cancellation: CancellationToken): Promise<Result<void, { readonly kind: 'cancelled' }>>;
}

export interface ClipboardPort {
  readText(cancellation: CancellationToken): Promise<Result<string, PlatformFailure>>;
  writeText(text: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  readPrimaryText?(cancellation: CancellationToken): Promise<Result<string, PlatformFailure>>;
  writePrimaryText?(text: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export interface ServicePort<Request, Response, Failure = PlatformFailure> {
  invoke(request: Request, cancellation: CancellationToken): Promise<Result<Response, Failure>>;
}

export interface PlatformPorts {
  readonly process: ProcessPort;
  readonly filesystem: FilesystemPort;
  readonly clock: ClockPort;
  readonly clipboard: ClipboardPort;
}

export interface InputModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

export type CanonicalInputEvent =
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly phase: 'press' | 'repeat' | 'release';
      readonly modifiers: InputModifiers;
      readonly rawBytes: Uint8Array;
    }
  | { readonly kind: 'paste'; readonly bytes: Uint8Array }
  | { readonly kind: 'focus'; readonly focused: boolean }
  | {
      readonly kind: 'pointer';
      readonly phase: 'down' | 'up' | 'move' | 'drag' | 'wheel';
      readonly cell: { readonly column0: number; readonly row0: number };
      readonly button: number | null;
      readonly modifiers: InputModifiers;
      readonly wheelDelta: number;
    };

/** Inert schema metadata; registry behavior belongs to the workbench owner. */
export interface CommandContract<Arguments, Output> {
  readonly id: CommandId;
  readonly contractVersion: number;
  readonly arguments: Decoder<Arguments>;
  readonly output: Decoder<Output>;
  readonly selectionPolicy: SelectionPolicy;
  readonly effect: CommandEffect;
}

/** Inert provider identity and capabilities; provider arbitration is separate. */
export interface ProviderContract<Capability extends string = string> {
  readonly id: ProviderId;
  readonly contractVersion: number;
  readonly capabilities: readonly Capability[];
}

export interface ServiceFactoryContext {
  readonly ports: PlatformPorts;
  readonly scope: DisposableScope;
  readonly requestId: RequestId;
}

export type ServiceFactory<Output> = (context: ServiceFactoryContext) => Promise<Output>;

export type {
  CancellationToken,
  CommandId,
  Disposable,
  DocumentId,
  DocumentVersion,
  ProviderId,
  RequestId,
  Result,
  SelectionGeneration,
  SelectionId,
  ValidationIssue,
  UndoGroupId,
  Utf16Offset,
  ViewId,
  WorkspaceId,
} from '../../primitives/src/index.ts';

/** Inert syntax-highlighting token classification, shared by the syntax service and the UI paint path. */
export type SyntaxTokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'boolean'
  | 'type'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'variable'
  | 'property'
  | 'constant';

/** A classified UTF-16 range. `start`/`end` are zero-based UTF-16 code-unit offsets. */
export interface SyntaxSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SyntaxTokenKind;
  /** Original Tree-sitter capture scope (for example `function.call`). The UI resolves this
   * against Helix's dotted scope hierarchy before falling back to the coarse kind. */
  readonly scope?: string;
}

/** A read-only, versioned view over one document's resolved syntax spans. */
export interface SyntaxRead {
  readonly documentVersion: DocumentVersion;
  /** Non-overlapping spans intersecting [start, end), sorted by start. Never scans the whole document. */
  spansInRange(start: number, end: number): readonly SyntaxSpan[];
}

/** Read-only syntax boundary. Never mutates a document; UI never parses text itself. */
export interface SyntaxReadPort {
  readSyntax(documentId: DocumentId): SyntaxRead | undefined;
}
