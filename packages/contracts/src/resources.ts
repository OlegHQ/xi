/**
 * Resource accounting is deliberately feature-neutral. A coordinator may
 * account a service or platform resource, but it never owns document text.
 */
export type ResourceKind = 'retained' | 'inflight' | 'queued' | 'native' | 'external';

export type ResourcePriority = 'speculative' | 'background' | 'interactive' | 'live';

export interface ResourceRequest {
  readonly owner: string;
  readonly kind: ResourceKind;
  readonly bytes: number;
  readonly priority: ResourcePriority;
  /** Reconstructible work may be discarded under pressure. */
  readonly reclaimable?: boolean;
  readonly label?: string;
  /** Called after the coordinator removes this lease during pressure eviction. */
  readonly onEvict?: () => void;
}

export type ResourceAdmissionFailure =
  | { readonly kind: 'disposed'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'pressure'; readonly message: string; readonly requestedBytes: number }
  | { readonly kind: 'owner-limit'; readonly owner: string; readonly limitBytes: number; readonly requestedBytes: number }
  | { readonly kind: 'capacity'; readonly limitBytes: number; readonly requestedBytes: number };

export interface ResourceLease {
  readonly id: number;
  readonly request: ResourceRequest;
  readonly bytes: number;
  readonly evicted: boolean;
  /** Replace the accounted size atomically; a failed growth keeps the old size. */
  update(bytes: number): { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: ResourceAdmissionFailure };
  dispose(): void;
}

export interface ResourceOwnerStats {
  readonly owner: string;
  readonly bytes: number;
  readonly retainedBytes: number;
  readonly inflightBytes: number;
  readonly queuedBytes: number;
  readonly nativeBytes: number;
  readonly externalBytes: number;
  readonly leases: number;
}

export interface ResourceStats {
  readonly capacityBytes: number;
  readonly pressureBytes: number;
  readonly accountedBytes: number;
  readonly externalBytes: number;
  readonly processBytes: number;
  readonly pressure: boolean;
  readonly hardExhausted: boolean;
  readonly leases: number;
  readonly evictions: number;
  readonly evictionFailures: number;
  readonly owners: ReadonlyMap<string, ResourceOwnerStats>;
}
