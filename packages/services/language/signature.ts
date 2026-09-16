import type { Disposable, Result } from '../../contracts/src/index';
import { requestIsSupported, type LanguageProviderSession } from './provider-session';

export interface SignaturePosition { readonly line: number; readonly utf16: number; }
export interface SignatureRequest { readonly documentId: string; readonly documentVersion: number; readonly selectionGeneration: number; readonly position: SignaturePosition; readonly uri?: string; }
export interface SignatureParameter { readonly label: string; readonly documentation?: string; }
export interface SignatureInformation { readonly id: string; readonly label: string; readonly documentation?: string; readonly parameters: readonly SignatureParameter[]; }
export type SignatureFailure = { readonly kind: 'stale' | 'unavailable' | 'disposed'; readonly message: string };
export interface SignatureList { readonly signatures: readonly SignatureInformation[]; readonly activeSignature: number; readonly activeParameter: number | undefined; }
export interface SignatureReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly request: SignatureRequest | undefined; readonly signatures: readonly SignatureInformation[]; readonly activeSignature: number; readonly activeParameter: number | undefined; readonly message: string | undefined; }

export interface SignatureProvider { request(request: SignatureRequest): Promise<Result<SignatureList, SignatureFailure>>; }

export class LanguageServerSignatureProvider implements SignatureProvider {
  readonly #session: LanguageProviderSession;
  constructor(session: LanguageProviderSession) { this.#session = session; }
  async request(request: SignatureRequest): Promise<Result<SignatureList, SignatureFailure>> {
    if (request.uri === undefined) return unavailable('signature request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/signatureHelp', request.uri)) return unavailable('language server does not provide signature help');
    try {
      const response = await this.#session.request<unknown>('textDocument/signatureHelp', {
        textDocument: { uri: request.uri },
        position: { line: request.position.line, character: request.position.utf16 },
      });
      if (response === null) return { ok: true, value: Object.freeze({ signatures: Object.freeze([]), activeSignature: 0, activeParameter: undefined }) };
      const record = asRecord(response);
      if (record === undefined || !Array.isArray(record.signatures)) return unavailable('language server returned invalid signature help');
      const signatures: SignatureInformation[] = [];
      for (let index = 0; index < record.signatures.length; index += 1) {
        const signature = parseSignature(record.signatures[index], `${request.documentId}:${request.documentVersion}:${index}`);
        if (signature === undefined) return unavailable('language server returned an invalid signature');
        signatures.push(signature);
      }
      const activeSignature = integer(record.activeSignature) ?? 0;
      const activeParameter = record.activeParameter === undefined ? undefined : integer(record.activeParameter);
      if (activeSignature >= signatures.length && signatures.length > 0) return unavailable('language server returned an invalid active signature');
      return { ok: true, value: Object.freeze({ signatures: Object.freeze(signatures), activeSignature, activeParameter }) };
    } catch (error: unknown) { return unavailable(error instanceof Error ? error.message : 'language signature request failed'); }
  }
}

export class SignatureController implements Disposable {
  readonly #provider: SignatureProvider;
  readonly #listeners = new Set<(model: SignatureReadModel) => void>();
  #model: SignatureReadModel = Object.freeze({ state: 'idle', request: undefined, signatures: Object.freeze([]), activeSignature: 0, activeParameter: undefined, message: undefined });
  #generation = 0;
  #disposed = false;
  constructor(provider: SignatureProvider) { this.#provider = provider; }
  get model(): SignatureReadModel { return this.#model; }
  subscribe(listener: (model: SignatureReadModel) => void): Disposable { if (this.#disposed) throw new Error('signature-controller-disposed'); this.#listeners.add(listener); return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } }); }
  async request(request: SignatureRequest): Promise<Result<SignatureList, SignatureFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'signature controller is disposed' } };
    const generation = ++this.#generation;
    this.setModel({ state: 'loading', request, signatures: Object.freeze([]), activeSignature: 0, activeParameter: undefined, message: undefined });
    const result = await this.#provider.request(request);
    if (this.#disposed || generation !== this.#generation) return { ok: false, error: { kind: 'stale', message: 'signature response is stale' } };
    if (!result.ok) { this.setModel({ ...this.#model, state: 'error', message: result.error.message }); return result; }
    this.setModel({ state: result.value.signatures.length === 0 ? 'idle' : 'ready', request, signatures: result.value.signatures, activeSignature: result.value.activeSignature, activeParameter: result.value.activeParameter, message: result.value.signatures.length === 0 ? 'No signature help' : undefined });
    return result;
  }
  cancel(): void { this.#generation += 1; this.setModel({ state: 'idle', request: undefined, signatures: Object.freeze([]), activeSignature: 0, activeParameter: undefined, message: undefined }); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#generation += 1; this.#listeners.clear(); }
  private setModel(model: SignatureReadModel): void { this.#model = Object.freeze(model); for (const listener of [...this.#listeners]) { try { listener(this.#model); } catch { /* observers cannot break signature dispatch */ } } }
}

function parseSignature(value: unknown, id: string): SignatureInformation | undefined {
  const record = asRecord(value);
  if (typeof record?.label !== 'string') return undefined;
  const documentation = markdown(record.documentation);
  const parameters: SignatureParameter[] = [];
  if (record.parameters !== undefined) {
    if (!Array.isArray(record.parameters)) return undefined;
    for (const value of record.parameters) { const parameter = asRecord(value); if (parameter === undefined || (typeof parameter.label !== 'string' && !(Array.isArray(parameter.label) && parameter.label.every((part) => integer(part))))) return undefined; const label = typeof parameter.label === 'string' ? parameter.label : `${parameter.label[0] ?? 0}-${parameter.label[1] ?? 0}`; const parameterDocumentation = markdown(parameter.documentation); parameters.push(Object.freeze({ label, ...(parameterDocumentation === undefined ? {} : { documentation: parameterDocumentation }) })); }
  }
  return Object.freeze({ id, label: record.label.slice(0, 64 * 1024), ...(documentation === undefined ? {} : { documentation }), parameters: Object.freeze(parameters) });
}
function markdown(value: unknown): string | undefined { if (typeof value === 'string') return value.slice(0, 64 * 1024); const record = asRecord(value); return typeof record?.value === 'string' ? record.value.slice(0, 64 * 1024) : undefined; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function unavailable(message: string): Result<never, SignatureFailure> { return { ok: false, error: { kind: 'unavailable', message } }; }
