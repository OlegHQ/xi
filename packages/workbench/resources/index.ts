import type {
  Disposable,
  ResourceAdmissionFailure,
  ResourceKind,
  ResourceLease,
  ResourceOwnerStats,
  ResourcePriority,
  ResourceRequest,
  ResourceStats,
} from '../../contracts/src/index.ts';

export const DEFAULT_SMALL_RESOURCE_CAPACITY_BYTES = 150 * 1024 * 1024;
export const DEFAULT_RESOURCE_PRESSURE_RATIO = 0.8;

export interface WorkbenchResourceCoordinatorOptions {
  /** The simultaneous editor, worker and native profile envelope. */
  readonly capacityBytes?: number;
  /** Pressure is applied at this fraction of the configured envelope. */
  readonly pressureRatio?: number;
  /** Optional per-owner maxima for service and workbench attribution. */
  readonly ownerLimitsBytes?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

export interface LargeResourceProfile {
  readonly inputBytes: number;
  readonly steadyRssBytes: number;
  readonly peakRssBytes: number;
}

/** The PF01/PF06 formula, kept separate from the ten-small-buffer envelope. */
export function largeResourceProfile(inputBytes: number): LargeResourceProfile {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw new RangeError('inputBytes must be a non-negative safe integer');
  return Object.freeze({
    inputBytes,
    steadyRssBytes: 150 * 1024 * 1024 + 3 * inputBytes,
    peakRssBytes: 200 * 1024 * 1024 + 4 * inputBytes,
  });
}

interface MutableOwnerStats {
  owner: string;
  bytes: number;
  retainedBytes: number;
  inflightBytes: number;
  queuedBytes: number;
  nativeBytes: number;
  externalBytes: number;
  leases: number;
}

interface ResourceEntry {
  readonly id: number;
  readonly request: ResourceRequest;
  bytes: number;
  active: boolean;
  evicted: boolean;
  lease: ResourceLeaseImpl;
}

const PRIORITY_RANK: Readonly<Record<ResourcePriority, number>> = Object.freeze({
  speculative: 0,
  background: 1,
  interactive: 2,
  live: 3,
});

/**
 * Aggregates resource reservations for the workbench. It accounts bytes by
 * owner and kind, evicts only explicitly reconstructible non-external work,
 * and never receives a document or a private storage reference.
 */
export class WorkbenchResourceCoordinator implements Disposable {
  readonly #capacityBytes: number;
  readonly #pressureBytes: number;
  readonly #ownerLimits: ReadonlyMap<string, number>;
  readonly #entries = new Map<number, ResourceEntry>();
  readonly #owners = new Map<string, MutableOwnerStats>();
  #nextId = 1;
  #accountedBytes = 0;
  #externalBytes = 0;
  #evictions = 0;
  #evictionFailures = 0;
  #disposed = false;

  constructor(options: WorkbenchResourceCoordinatorOptions = {}) {
    this.#capacityBytes = checkedBytes(options.capacityBytes ?? DEFAULT_SMALL_RESOURCE_CAPACITY_BYTES, 'capacityBytes');
    const pressureRatio = options.pressureRatio ?? DEFAULT_RESOURCE_PRESSURE_RATIO;
    if (!Number.isFinite(pressureRatio) || pressureRatio <= 0 || pressureRatio > 1) throw new RangeError('pressureRatio must be in (0, 1]');
    this.#pressureBytes = Math.max(1, Math.floor(this.#capacityBytes * pressureRatio));
    this.#ownerLimits = normalizeOwnerLimits(options.ownerLimitsBytes);
  }

  get disposed(): boolean { return this.#disposed; }

  /** Admit a reservation atomically. No bytes or owner counters change on failure. */
  admit(request: ResourceRequest): { readonly ok: true; readonly value: ResourceLease } | { readonly ok: false; readonly error: ResourceAdmissionFailure } {
    const checked = validateRequest(request);
    if (!checked.ok) return checked;
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'resource coordinator is disposed' } };

    this.applyPressure();
    if (request.priority === 'speculative' && this.isUnderPressure()) {
      return { ok: false, error: { kind: 'pressure', message: 'speculative work is paused while the resource envelope is under pressure', requestedBytes: request.bytes } };
    }

    const ownerLimit = this.#ownerLimits.get(request.owner);
    if (ownerLimit !== undefined && this.ownerBytes(request.owner) + request.bytes > ownerLimit) {
      this.reclaimTo(ownerLimit - request.bytes, request.owner);
      if (this.ownerBytes(request.owner) + request.bytes > ownerLimit) {
        return { ok: false, error: { kind: 'owner-limit', owner: request.owner, limitBytes: ownerLimit, requestedBytes: request.bytes } };
      }
    }

    if (this.processBytes() + request.bytes > this.#capacityBytes) {
      this.reclaimTo(this.#capacityBytes - request.bytes);
      if (this.processBytes() + request.bytes > this.#capacityBytes) {
        return { ok: false, error: { kind: 'capacity', limitBytes: this.#capacityBytes, requestedBytes: request.bytes } };
      }
    }

    const id = this.#nextId++;
    const normalized = normalizeRequest(request);
    const entry = {} as ResourceEntry;
    const lease = new ResourceLeaseImpl(this, entry);
    Object.assign(entry, { id, request: normalized, bytes: request.bytes, active: true, evicted: false, lease });
    this.#entries.set(id, entry);
    this.adjustOwner(normalized.owner, normalized.kind, request.bytes, 1);
    this.applyPressure();
    return { ok: true, value: lease };
  }

  /** Observe an external process or native allocation without making it reclaimable. */
  admitExternal(owner: string, bytes: number, label?: string): { readonly ok: true; readonly value: ResourceLease } | { readonly ok: false; readonly error: ResourceAdmissionFailure } {
    return this.admit({
      owner,
      kind: 'external',
      bytes,
      priority: 'live',
      ...(label === undefined ? {} : { label }),
    });
  }

  /** Release eligible work until the profile is below its pressure watermark. */
  applyPressure(): number {
    if (this.processBytes() <= this.#pressureBytes) return 0;
    return this.reclaimTo(this.#pressureBytes);
  }

  stats(): ResourceStats {
    const owners = new Map<string, ResourceOwnerStats>();
    for (const value of this.#owners.values()) owners.set(value.owner, Object.freeze({ ...value }));
    return Object.freeze({
      capacityBytes: this.#capacityBytes,
      pressureBytes: this.#pressureBytes,
      accountedBytes: this.#accountedBytes,
      externalBytes: this.#externalBytes,
      processBytes: this.processBytes(),
      pressure: this.isUnderPressure(),
      hardExhausted: this.processBytes() >= this.#capacityBytes,
      leases: this.#entries.size,
      evictions: this.#evictions,
      evictionFailures: this.#evictionFailures,
      owners,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of [...this.#entries.values()]) this.removeEntry(entry, true);
    this.#entries.clear();
    this.#owners.clear();
    this.#accountedBytes = 0;
    this.#externalBytes = 0;
  }

  release(lease: ResourceLeaseImpl): void {
    const entry = lease.entry;
    if (!entry.active || this.#entries.get(entry.id) !== entry) return;
    this.removeEntry(entry, false);
  }

  update(lease: ResourceLeaseImpl, bytes: number): { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: ResourceAdmissionFailure } {
    const entry = lease.entry;
    const checked = validateBytes(bytes);
    if (!checked.ok) return checked;
    if (this.#disposed || !entry.active || this.#entries.get(entry.id) !== entry) {
      return { ok: false, error: { kind: 'disposed', message: 'resource lease is no longer active' } };
    }
    const delta = bytes - entry.bytes;
    if (delta <= 0) {
      this.adjustOwner(entry.request.owner, entry.request.kind, delta, 0);
      entry.bytes = bytes;
      return { ok: true, value: undefined };
    }
    this.applyPressure();
    if (entry.request.priority === 'speculative' && this.isUnderPressure()) {
      return { ok: false, error: { kind: 'pressure', message: 'speculative work is paused while the resource envelope is under pressure', requestedBytes: bytes } };
    }
    const ownerLimit = this.#ownerLimits.get(entry.request.owner);
    if (ownerLimit !== undefined && this.ownerBytes(entry.request.owner) + delta > ownerLimit) {
      this.reclaimTo(ownerLimit - delta, entry.request.owner, entry.id);
      if (this.ownerBytes(entry.request.owner) + delta > ownerLimit) {
        return { ok: false, error: { kind: 'owner-limit', owner: entry.request.owner, limitBytes: ownerLimit, requestedBytes: bytes } };
      }
    }
    if (this.processBytes() + delta > this.#capacityBytes) {
      this.reclaimTo(this.#capacityBytes - delta, undefined, entry.id);
      if (this.processBytes() + delta > this.#capacityBytes) {
        return { ok: false, error: { kind: 'capacity', limitBytes: this.#capacityBytes, requestedBytes: bytes } };
      }
    }
    this.adjustOwner(entry.request.owner, entry.request.kind, delta, 0);
    entry.bytes = bytes;
    this.applyPressure();
    return { ok: true, value: undefined };
  }

  private processBytes(): number { return this.#accountedBytes + this.#externalBytes; }

  private ownerBytes(owner: string): number { return this.#owners.get(owner)?.bytes ?? 0; }

  private adjustOwner(owner: string, kind: ResourceKind, delta: number, leaseDelta: number): void {
    const current = this.#owners.get(owner) ?? {
      owner,
      bytes: 0,
      retainedBytes: 0,
      inflightBytes: 0,
      queuedBytes: 0,
      nativeBytes: 0,
      externalBytes: 0,
      leases: 0,
    } satisfies MutableOwnerStats;
    current.bytes += delta;
    current.leases += leaseDelta;
    if (kind === 'retained') current.retainedBytes += delta;
    if (kind === 'inflight') current.inflightBytes += delta;
    if (kind === 'queued') current.queuedBytes += delta;
    if (kind === 'native') current.nativeBytes += delta;
    if (kind === 'external') current.externalBytes += delta;
    if (delta !== 0) {
      if (kind === 'external') this.#externalBytes += delta;
      else this.#accountedBytes += delta;
    }
    if (current.leases === 0) this.#owners.delete(owner);
    else this.#owners.set(owner, current);
  }

  private reclaimTo(targetBytes: number, owner?: string, excludedId?: number): number {
    const candidates = [...this.#entries.values()]
      .filter((entry) => entry.active && entry.id !== excludedId && entry.request.kind !== 'external' && entry.request.reclaimable === true && (owner === undefined || entry.request.owner === owner))
      .sort((a, b) => PRIORITY_RANK[a.request.priority] - PRIORITY_RANK[b.request.priority] || a.id - b.id);
    let removed = 0;
    for (const entry of candidates) {
      if ((owner === undefined ? this.processBytes() : this.ownerBytes(owner)) <= targetBytes) break;
      this.removeEntry(entry, true);
      removed += 1;
    }
    return removed;
  }

  private removeEntry(entry: ResourceEntry, evict: boolean): void {
    if (!entry.active || this.#entries.get(entry.id) !== entry) return;
    entry.active = false;
    entry.evicted = evict;
    this.#entries.delete(entry.id);
    this.adjustOwner(entry.request.owner, entry.request.kind, -entry.bytes, -1);
    if (!evict) return;
    this.#evictions += 1;
    try {
      entry.request.onEvict?.();
    } catch {
      this.#evictionFailures += 1;
    }
  }

  private isUnderPressure(): boolean { return this.processBytes() >= this.#pressureBytes; }
}

class ResourceLeaseImpl implements ResourceLease {
  readonly entry: ResourceEntry;
  readonly #coordinator: WorkbenchResourceCoordinator;

  constructor(coordinator: WorkbenchResourceCoordinator, entry: ResourceEntry) {
    this.#coordinator = coordinator;
    this.entry = entry;
  }

  get id(): number { return this.entry.id; }
  get request(): ResourceRequest { return this.entry.request; }
  get bytes(): number { return this.entry.bytes; }
  get evicted(): boolean { return this.entry.evicted; }
  update(bytes: number): { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: ResourceAdmissionFailure } { return this.#coordinator.update(this, bytes); }
  dispose(): void { this.#coordinator.release(this); }
}

function checkedBytes(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function validateBytes(value: number): { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: ResourceAdmissionFailure } {
  return Number.isSafeInteger(value) && value > 0
    ? { ok: true, value: undefined }
    : { ok: false, error: { kind: 'invalid', message: 'resource bytes must be a positive safe integer' } };
}

function validateRequest(request: ResourceRequest): { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: ResourceAdmissionFailure } {
  if (typeof request.owner !== 'string' || request.owner.length === 0) return { ok: false, error: { kind: 'invalid', message: 'resource owner is required' } };
  if (!isKind(request.kind) || !isPriority(request.priority)) return { ok: false, error: { kind: 'invalid', message: 'resource kind or priority is invalid' } };
  return validateBytes(request.bytes);
}

function normalizeRequest(request: ResourceRequest): ResourceRequest {
  return Object.freeze({
    owner: request.owner,
    kind: request.kind,
    bytes: request.bytes,
    priority: request.priority,
    reclaimable: request.reclaimable === true,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.onEvict === undefined ? {} : { onEvict: request.onEvict }),
  });
}

function normalizeOwnerLimits(input: WorkbenchResourceCoordinatorOptions['ownerLimitsBytes']): ReadonlyMap<string, number> {
  if (input === undefined) return new Map();
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const output = new Map<string, number>();
  for (const [owner, bytes] of entries) output.set(owner, checkedBytes(bytes, `owner limit for ${owner}`));
  return output;
}

function isKind(value: string): value is ResourceKind { return value === 'retained' || value === 'inflight' || value === 'queued' || value === 'native' || value === 'external'; }
function isPriority(value: string): value is ResourcePriority { return value === 'speculative' || value === 'background' || value === 'interactive' || value === 'live'; }
