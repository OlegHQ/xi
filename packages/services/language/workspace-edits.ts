import type { CancellationToken, Disposable, Result } from '../../contracts/src/index';
import { requestIsSupported, type LanguageProviderSession } from './provider-session';

export interface WorkspaceTextEdit {
  readonly uri: string;
  readonly version: number;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly annotationId?: string;
}
export type WorkspaceResourceOperation = {
  readonly kind: 'create' | 'rename' | 'delete';
  readonly uri: string;
  readonly newUri?: string;
  readonly annotationId?: string;
  readonly options?: { readonly overwrite?: boolean; readonly ignoreIfExists?: boolean; readonly ignoreIfNotExists?: boolean; readonly recursive?: boolean };
};
export interface WorkspaceEditProposal { readonly edits: readonly WorkspaceTextEdit[]; readonly resources?: readonly WorkspaceResourceOperation[]; readonly requestId: string; }
export interface WorkspaceEditTarget {
  readonly uri: string;
  readonly version: number;
  readonly textLength: number;
  /** Optional source identity used to revalidate closed files before mutation. */
  readonly contentHash?: string;
}
export interface WorkspaceEditPort {
  preflight(targets: readonly WorkspaceEditTarget[], resources: readonly WorkspaceResourceOperation[]): Promise<Result<void, WorkspaceEditFailure>>;
  apply(edits: readonly WorkspaceTextEdit[], resources: readonly WorkspaceResourceOperation[], targets?: readonly WorkspaceEditTarget[]): Promise<Result<void, WorkspaceEditFailure>>;
}
export type WorkspaceEditFailure = { readonly kind: 'stale' | 'overlap' | 'collision' | 'invalid-range' | 'apply' | 'disposed'; readonly message: string; readonly uri?: string };

export interface WorkspaceEditPosition { readonly line: number; readonly utf16: number; }
/** A versioned document resolver used for open and closed workspace files. */
export interface WorkspaceEditDocument {
  readonly target: WorkspaceEditTarget;
  readonly offset: (position: WorkspaceEditPosition) => Result<number, WorkspaceEditProviderFailure>;
}
export interface WorkspaceEditRequest { readonly documentId: string; readonly uri: string; readonly version: number; readonly position: WorkspaceEditPosition; }
export interface CodeActionRequest extends WorkspaceEditRequest { readonly diagnostics?: readonly unknown[]; readonly only?: readonly string[]; readonly cancellation?: CancellationToken; }
export interface LanguageCodeAction {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly disabledReason?: string;
  readonly data?: unknown;
  readonly edit?: WorkspaceEditProposal;
  readonly command?: { readonly title: string; readonly command: string; readonly arguments: readonly unknown[] };
}
export type WorkspaceEditProviderFailure = { readonly kind: 'unavailable' | 'invalid' | 'stale'; readonly message: string };
export type WorkspaceFileOperationKind = 'create' | 'rename' | 'delete';
export type LanguageCodeActionExecutionFailure = { readonly kind: 'disabled' | 'edit' | 'command'; readonly message: string };

export interface LanguageCodeActionExecutor {
  apply(proposal: WorkspaceEditProposal): Promise<Result<void, WorkspaceEditFailure>>;
  execute(command: NonNullable<LanguageCodeAction['command']>): Promise<Result<void, { readonly kind: 'unsupported' | 'failed'; readonly message: string }>>;
}

/** Runs the one selected action in protocol order and reports a partial result. */
export async function executeLanguageCodeAction(
  action: LanguageCodeAction,
  executor: LanguageCodeActionExecutor,
): Promise<Result<{ readonly editApplied: boolean; readonly commandExecuted: boolean }, LanguageCodeActionExecutionFailure>> {
  if (action.disabledReason !== undefined) return { ok: false, error: { kind: 'disabled', message: action.disabledReason } };
  if (action.edit !== undefined) {
    const applied = await executor.apply(action.edit);
    if (!applied.ok) return { ok: false, error: { kind: 'edit', message: applied.error.message } };
  }
  if (action.command !== undefined) {
    const executed = await executor.execute(action.command);
    if (!executed.ok) return { ok: false, error: { kind: 'command', message: executed.error.message } };
  }
  return { ok: true, value: { editApplied: action.edit !== undefined, commandExecuted: action.command !== undefined } };
}

/** Native LSP adapter. It decodes workspace ranges only with caller-provided, versioned targets. */
export class LanguageServerWorkspaceEditProvider {
  readonly #session: LanguageProviderSession;
  readonly #target: ((uri: string) => WorkspaceEditTarget | undefined | Promise<WorkspaceEditTarget | undefined>) | undefined;
  readonly #offset: ((uri: string, position: WorkspaceEditPosition) => Result<number, WorkspaceEditProviderFailure>) | undefined;
  readonly #document: ((uri: string) => WorkspaceEditDocument | undefined | Promise<WorkspaceEditDocument | undefined>) | undefined;
  constructor(options: {
    readonly session: LanguageProviderSession;
    readonly target?: (uri: string) => WorkspaceEditTarget | undefined | Promise<WorkspaceEditTarget | undefined>;
    readonly offset?: (uri: string, position: WorkspaceEditPosition) => Result<number, WorkspaceEditProviderFailure>;
    readonly document?: (uri: string) => WorkspaceEditDocument | undefined | Promise<WorkspaceEditDocument | undefined>;
  }) {
    this.#session = options.session;
    this.#target = options.target;
    this.#offset = options.offset;
    this.#document = options.document;
  }

  async codeActions(request: CodeActionRequest): Promise<Result<readonly LanguageCodeAction[], WorkspaceEditProviderFailure>> {
    if (!requestIsSupported(this.#session, 'textDocument/codeAction', request.uri)) return unavailable('language server does not provide code actions');
    try {
      const response = await this.#session.request<unknown>('textDocument/codeAction', {
        textDocument: { uri: request.uri },
        range: { start: { line: request.position.line, character: request.position.utf16 }, end: { line: request.position.line, character: request.position.utf16 } },
        context: { diagnostics: request.diagnostics ?? [], ...(request.only === undefined ? {} : { only: request.only }) },
      }, request.cancellation);
      if (response === null) return { ok: true, value: Object.freeze([]) };
      if (!Array.isArray(response)) return unavailable('language server returned invalid code actions');
      const actions: LanguageCodeAction[] = [];
      for (let index = 0; index < response.length; index += 1) {
        const action = await parseCodeAction(response[index], `${request.documentId}:${request.version}:${index}`, (value, requestId) => this.decodeEdit(value, requestId));
        if (!action.ok) return action;
        actions.push(action.value);
      }
      return { ok: true, value: Object.freeze(actions) };
    } catch (error: unknown) { return unavailable(error instanceof Error ? error.message : 'language code action request failed'); }
  }

  async resolveCodeAction(action: LanguageCodeAction): Promise<Result<LanguageCodeAction, WorkspaceEditProviderFailure>> {
    if (action.data === undefined) return { ok: true, value: action };
    if (!requestIsSupported(this.#session, 'codeAction/resolve')) return unavailable('language server does not provide code action resolution');
    try {
      const response = await this.#session.request<unknown>('codeAction/resolve', {
        title: action.title,
        ...(action.kind === undefined ? {} : { kind: action.kind }),
        data: action.data,
      });
      const resolved = await parseCodeAction(response, action.id, (value, requestId) => this.decodeEdit(value, requestId));
      return resolved.ok ? { ok: true, value: Object.freeze({ ...resolved.value, id: action.id }) } : resolved;
    } catch (error: unknown) {
      return unavailable(error instanceof Error ? error.message : 'language code action resolve failed');
    }
  }

  async willFileOperation(kind: WorkspaceFileOperationKind, files: readonly WorkspaceResourceOperation[]): Promise<Result<WorkspaceEditProposal | undefined, WorkspaceEditProviderFailure>> {
    const method = kind === 'create' ? 'workspace/willCreateFiles' : kind === 'rename' ? 'workspace/willRenameFiles' : 'workspace/willDeleteFiles';
    if (!requestIsSupported(this.#session, method)) return { ok: true, value: undefined };
    const params = { files: files.map((file) => file.kind === 'rename' ? { oldUri: file.uri, newUri: file.newUri, options: file.options } : { uri: file.uri, options: file.options }) };
    try {
      const response = await this.#session.request<unknown>(method, params);
      return response === null ? { ok: true, value: undefined } : this.decodeEdit(response, `${kind}:will:${files.map((file) => file.uri).join('|')}`);
    } catch (error: unknown) {
      return unavailable(error instanceof Error ? error.message : `${method} failed`);
    }
  }

  async didFileOperation(kind: WorkspaceFileOperationKind, files: readonly WorkspaceResourceOperation[]): Promise<Result<void, WorkspaceEditProviderFailure>> {
    if (this.#session.notify === undefined) return { ok: false, error: { kind: 'unavailable', message: 'language session cannot send file-operation notifications' } };
    const method = kind === 'create' ? 'workspace/didCreateFiles' : kind === 'rename' ? 'workspace/didRenameFiles' : 'workspace/didDeleteFiles';
    if (!requestIsSupported(this.#session, method)) return { ok: false, error: { kind: 'unavailable', message: 'language server did not register this file operation' } };
    const params = { files: files.map((file) => file.kind === 'rename' ? { oldUri: file.uri, newUri: file.newUri } : { uri: file.uri }) };
    try { await this.#session.notify(method, params); return { ok: true, value: undefined }; }
    catch (error: unknown) { return unavailable(error instanceof Error ? error.message : `${method} failed`); }
  }

  async prepareRename(request: WorkspaceEditRequest): Promise<Result<{ readonly start: number; readonly end: number; readonly placeholder?: string } | undefined, WorkspaceEditProviderFailure>> {
    if (!requestIsSupported(this.#session, 'textDocument/prepareRename', request.uri)) return unavailable('language server does not provide rename preparation');
    try {
      const response = await this.#session.request<unknown>('textDocument/prepareRename', lspPositionParams(request));
      if (response === null) return { ok: true, value: undefined };
      const record = asRecord(response);
      const range = asRecord(record?.range ?? response);
      const start = asRecord(range?.start); const end = asRecord(range?.end);
      if (start === undefined || end === undefined) return unavailable('language server returned invalid rename range');
      const startOffset = await this.resolveOffset(request.uri, position(start)); const endOffset = await this.resolveOffset(request.uri, position(end));
      if (!startOffset.ok || !endOffset.ok || endOffset.value < startOffset.value) return unavailable('language server returned an invalid rename range');
      return { ok: true, value: { start: startOffset.value, end: endOffset.value, ...(typeof record?.placeholder === 'string' ? { placeholder: record.placeholder } : {}) } };
    } catch (error: unknown) { return unavailable(error instanceof Error ? error.message : 'language rename preparation failed'); }
  }

  async rename(request: WorkspaceEditRequest, newName: string): Promise<Result<WorkspaceEditProposal, WorkspaceEditProviderFailure>> {
    if (newName.length === 0) return unavailable('rename name must be non-empty');
    if (!requestIsSupported(this.#session, 'textDocument/rename', request.uri)) return unavailable('language server does not provide rename');
    try {
      const response = await this.#session.request<unknown>('textDocument/rename', { ...lspPositionParams(request), newName });
      return await this.decodeEdit(response, `${request.documentId}:rename:${request.version}`);
    } catch (error: unknown) { return unavailable(error instanceof Error ? error.message : 'language rename request failed'); }
  }

  private async decodeEdit(response: unknown, requestId: string): Promise<Result<WorkspaceEditProposal, WorkspaceEditProviderFailure>> {
    if (response === null) return { ok: true, value: { requestId, edits: Object.freeze([]), resources: Object.freeze([]) } };
    const record = asRecord(response);
    if (record === undefined) return unavailable('language server returned invalid workspace edit');
    const edits: WorkspaceTextEdit[] = [];
    const documents = new Map<string, Promise<Result<WorkspaceEditDocument, WorkspaceEditProviderFailure>>>();
    const resolve = (uri: string): Promise<Result<WorkspaceEditDocument, WorkspaceEditProviderFailure>> => {
      const cached = documents.get(uri);
      if (cached !== undefined) return cached;
      const pending = this.resolveDocument(uri);
      documents.set(uri, pending);
      return pending;
    };
    const changes = asRecord(record.changes);
    if (changes !== undefined) {
      for (const [uri, values] of Object.entries(changes)) {
        if (!Array.isArray(values)) return unavailable(`workspace edit changes for ${uri} are invalid`);
        const resolved = await resolve(uri); if (!resolved.ok) return resolved;
        for (const value of values) { const edit = await parseTextEdit(uri, resolved.value.target.version, value, resolved.value.offset); if (!edit.ok) return edit; edits.push(edit.value); }
      }
    }
    const resources: WorkspaceResourceOperation[] = [];
    if (Array.isArray(record.documentChanges)) {
      for (const value of record.documentChanges) {
        const change = asRecord(value); if (change === undefined) return unavailable('workspace resource change is invalid');
        const kind = change.kind;
        if (kind === 'create' || kind === 'delete') {
          if (typeof change.uri !== 'string') return unavailable('workspace resource URI is invalid');
          const options = resourceOptions(change.options);
          resources.push({ kind, uri: change.uri, ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}), ...(options === undefined ? {} : { options }) });
          continue;
        }
        if (kind === 'rename') {
          if (typeof change.oldUri !== 'string' || typeof change.newUri !== 'string') return unavailable('workspace rename URIs are invalid');
          const options = resourceOptions(change.options);
          resources.push({ kind, uri: change.oldUri, newUri: change.newUri, ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}), ...(options === undefined ? {} : { options }) });
          continue;
        }
        if (typeof change.textDocument !== 'object' || change.textDocument === null || !Array.isArray(change.edits)) return unavailable('versioned workspace document change is invalid');
        const textDocument = change.textDocument as Record<string, unknown>;
        const uri = typeof textDocument.uri === 'string' ? textDocument.uri : undefined;
        if (uri === undefined) return stale('versioned workspace edit has no URI');
        const resolved = await resolve(uri); if (!resolved.ok) return resolved;
        if (textDocument.version !== null && textDocument.version !== undefined && textDocument.version !== resolved.value.target.version) return stale(`versioned workspace edit is stale: ${uri}`);
        for (const editValue of change.edits) { const edit = await parseTextEdit(uri, resolved.value.target.version, editValue, resolved.value.offset); if (!edit.ok) return edit; edits.push(edit.value); }
      }
    }
    return { ok: true, value: Object.freeze({ requestId, edits: Object.freeze(edits), resources: Object.freeze(resources) }) };
  }

  private async resolveDocument(uri: string): Promise<Result<WorkspaceEditDocument, WorkspaceEditProviderFailure>> {
    if (this.#document !== undefined) {
      const resolved = await this.#document(uri);
      if (resolved === undefined) return stale(`workspace edit target is unavailable: ${uri}`);
      return { ok: true, value: resolved };
    }
    if (this.#target === undefined || this.#offset === undefined) return unavailable(`workspace edit target resolver is unavailable: ${uri}`);
    const target = await this.#target(uri);
    if (target === undefined) return stale(`workspace edit target is closed: ${uri}`);
    return { ok: true, value: { target, offset: (position) => this.#offset?.(uri, position) ?? unavailable('workspace edit position resolver is unavailable') } };
  }

  private async resolveOffset(uri: string, positionValue: WorkspaceEditPosition): Promise<Result<number, WorkspaceEditProviderFailure>> {
    const document = await this.resolveDocument(uri);
    return document.ok ? document.value.offset(positionValue) : document;
  }
}

/** Validates and applies one coherent LSP workspace edit through the workbench port. */
export class WorkspaceEditCoordinator implements Disposable {
  readonly #port: WorkspaceEditPort; #disposed = false; #active = new Set<string>();
  constructor(port: WorkspaceEditPort) { this.#port = port; }
  async apply(proposal: WorkspaceEditProposal, targets: readonly WorkspaceEditTarget[]): Promise<Result<void, WorkspaceEditFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'workspace edit coordinator disposed' } };
    if (this.#active.has(proposal.requestId)) return { ok: false, error: { kind: 'apply', message: 'workspace edit request is already applying' } };
    this.#active.add(proposal.requestId);
    try {
      const valid = validateProposal(proposal, targets); if (!valid.ok) return valid;
      const preflight = await this.#port.preflight(targets, proposal.resources ?? []); if (!preflight.ok) return preflight;
      return await this.#port.apply(proposal.edits, proposal.resources ?? [], targets);
    } finally { this.#active.delete(proposal.requestId); }
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#active.clear(); }
}

function validateProposal(proposal: WorkspaceEditProposal, targets: readonly WorkspaceEditTarget[]): Result<void, WorkspaceEditFailure> {
  const byUri = new Map(targets.map((target) => [target.uri, target]));
  const grouped = new Map<string, WorkspaceTextEdit[]>();
  for (const edit of proposal.edits) { const target = byUri.get(edit.uri); if (target === undefined || target.version !== edit.version) return { ok: false, error: { kind: 'stale', message: `workspace edit version is stale for ${edit.uri}`, uri: edit.uri } }; if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > target.textLength) return { ok: false, error: { kind: 'invalid-range', message: `workspace edit range is invalid for ${edit.uri}`, uri: edit.uri } }; (grouped.get(edit.uri) ?? (grouped.set(edit.uri, []), grouped.get(edit.uri)!)).push(edit); }
  for (const [uri, edits] of grouped) { const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end); for (let index = 1; index < sorted.length; index += 1) { const prior = sorted[index - 1]; const current = sorted[index]; if (prior && current && current.start < prior.end) return { ok: false, error: { kind: 'overlap', message: `workspace edits overlap for ${uri}`, uri } }; } }
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const resource of proposal.resources ?? []) {
    if (sources.has(resource.uri)) return { ok: false, error: { kind: 'collision', message: `workspace resource source is duplicated: ${resource.uri}`, uri: resource.uri } };
    sources.add(resource.uri);
    if (resource.kind === 'rename') {
      if (resource.newUri === undefined || resource.newUri === resource.uri || destinations.has(resource.newUri)) return { ok: false, error: { kind: 'collision', message: 'workspace resource destination collides', uri: resource.uri } };
      destinations.add(resource.newUri);
    }
  }
  return { ok: true, value: undefined };
}

async function parseCodeAction(value: unknown, id: string, decode: (response: unknown, requestId: string) => Promise<Result<WorkspaceEditProposal, WorkspaceEditProviderFailure>>): Promise<Result<LanguageCodeAction, WorkspaceEditProviderFailure>> {
  const record = asRecord(value);
  if (record === undefined || typeof record.title !== 'string') return unavailable('language server returned an invalid code action');
  const disabled = asRecord(record.disabled);
  const edit = record.edit === undefined ? undefined : await decode(record.edit, `${id}:edit`);
  if (edit !== undefined && !edit.ok) return edit;
  const commandRecord = asRecord(record.command);
  const command = commandRecord === undefined || typeof commandRecord.command !== 'string' || typeof commandRecord.title !== 'string'
    ? undefined
    : { title: commandRecord.title, command: commandRecord.command, arguments: Array.isArray(commandRecord.arguments) ? Object.freeze(commandRecord.arguments) : Object.freeze([]) };
  return { ok: true, value: Object.freeze({ id, title: record.title, ...(typeof record.kind === 'string' ? { kind: record.kind } : {}), ...(typeof record.data === 'object' && record.data !== null ? { data: record.data } : {}), ...(typeof disabled?.reason === 'string' ? { disabledReason: disabled.reason } : {}), ...(edit === undefined ? {} : { edit: edit.value }), ...(command === undefined ? {} : { command }) }) };
}

async function parseTextEdit(uri: string, version: number, value: unknown, offset: (position: WorkspaceEditPosition) => Result<number, WorkspaceEditProviderFailure>): Promise<Result<WorkspaceTextEdit, WorkspaceEditProviderFailure>> {
  const record = asRecord(value); const range = asRecord(record?.range); const start = asRecord(range?.start); const end = asRecord(range?.end);
  if (record === undefined || start === undefined || end === undefined || typeof record.newText !== 'string') return unavailable(`workspace text edit is invalid for ${uri}`);
  const from = offset(position(start)); const to = offset(position(end));
  if (!from.ok || !to.ok || to.value < from.value) return unavailable(`workspace text edit range is invalid for ${uri}`);
  return { ok: true, value: Object.freeze({ uri, version, start: from.value, end: to.value, newText: record.newText, ...(typeof record.annotationId === 'string' ? { annotationId: record.annotationId } : {}) }) };
}

function resourceOptions(value: unknown): WorkspaceResourceOperation['options'] | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const overwrite = typeof record.overwrite === 'boolean' ? record.overwrite : undefined;
  const ignoreIfExists = typeof record.ignoreIfExists === 'boolean' ? record.ignoreIfExists : undefined;
  const ignoreIfNotExists = typeof record.ignoreIfNotExists === 'boolean' ? record.ignoreIfNotExists : undefined;
  const recursive = typeof record.recursive === 'boolean' ? record.recursive : undefined;
  return overwrite === undefined && ignoreIfExists === undefined && ignoreIfNotExists === undefined && recursive === undefined ? undefined : Object.freeze({ ...(overwrite === undefined ? {} : { overwrite }), ...(ignoreIfExists === undefined ? {} : { ignoreIfExists }), ...(ignoreIfNotExists === undefined ? {} : { ignoreIfNotExists }), ...(recursive === undefined ? {} : { recursive }) });
}

function lspPositionParams(request: WorkspaceEditRequest): Record<string, unknown> { return { textDocument: { uri: request.uri }, position: { line: request.position.line, character: request.position.utf16 } }; }
function position(value: Record<string, unknown>): WorkspaceEditPosition { return { line: typeof value.line === 'number' ? value.line : -1, utf16: typeof value.character === 'number' ? value.character : -1 }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function unavailable(message: string): Result<never, WorkspaceEditProviderFailure> { return { ok: false, error: { kind: 'unavailable', message } }; }
function stale(message: string): Result<never, WorkspaceEditProviderFailure> { return { ok: false, error: { kind: 'stale', message } }; }
