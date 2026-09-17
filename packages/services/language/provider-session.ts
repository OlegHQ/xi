import type { CancellationToken } from '../../contracts/src/index';

/** Minimal session contract shared by the production LSP feature adapters. */
export interface LanguageProviderSession {
  request<Response>(method: string, params?: unknown, cancellation?: CancellationToken): Promise<Response>;
  notify?(method: string, params?: unknown): Promise<void>;
  /** Returns false when the current server has not negotiated this feature. */
  supportsRequest?(method: string, uri?: string): boolean;
}

/** Older isolated provider fixtures can omit negotiation; production sessions always implement it. */
export function requestIsSupported(session: LanguageProviderSession, method: string, uri?: string): boolean {
  return session.supportsRequest === undefined || session.supportsRequest(method, uri);
}
