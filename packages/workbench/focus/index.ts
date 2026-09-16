import type { CanonicalInputEvent, Disposable, Result } from '../../contracts/src/index.ts';

export type FocusDirection = 'next' | 'previous' | 'left' | 'right' | 'up' | 'down';
export type FocusTargetKind = 'editor' | 'panel' | 'overlay' | 'picker' | 'status';

export type FocusInputResult =
  | { readonly kind: 'consumed'; readonly detail?: string }
  | { readonly kind: 'pending'; readonly detail?: string }
  | { readonly kind: 'unhandled'; readonly detail?: string };

export interface FocusTarget {
  /** Stable identity. Row indexes and renderable object identity are not valid IDs. */
  readonly id: string;
  readonly kind: FocusTargetKind;
  /** Contexts are used by availability and command binding resolution. */
  readonly contexts: readonly string[];
  /** Optional widget handling for pointer, paste, and keys without a command binding. */
  readonly handleInput?: (event: CanonicalInputEvent) => FocusInputResult | Promise<FocusInputResult>;
}

export interface FocusEdge {
  readonly direction: FocusDirection;
  readonly targetId: string;
}

export interface FocusRegistrationOptions {
  readonly edges?: readonly FocusEdge[];
  readonly focus?: boolean;
}

export type FocusGraphFailure =
  | { readonly kind: 'focus-disposed'; readonly targetId: string }
  | { readonly kind: 'target-disposed'; readonly targetId: string }
  | { readonly kind: 'duplicate-target'; readonly targetId: string }
  | { readonly kind: 'invalid-target'; readonly message: string }
  | { readonly kind: 'missing-target'; readonly targetId: string }
  | { readonly kind: 'duplicate-edge'; readonly targetId: string; readonly direction: FocusDirection }
  | { readonly kind: 'graph-disposed' };

export interface FocusTargetSnapshot {
  readonly id: string;
  readonly kind: FocusTargetKind;
  readonly contexts: readonly string[];
  readonly edges: readonly FocusEdge[];
}

export interface FocusGraphSnapshot {
  readonly generation: number;
  readonly activeTargetId: string | undefined;
  readonly targets: readonly FocusTargetSnapshot[];
  readonly overlayDepth: number;
}

type FocusRecord = {
  readonly target: FocusTarget;
  readonly order: number;
  readonly edges: Map<FocusDirection, string>;
};

type OverlayRecord = {
  readonly targetId: string;
  readonly previousTargetId: string | undefined;
  readonly registration: FocusHandle;
};

/**
 * Owns focus identity and transitions. It never infers focus from rendered
 * text, and all fallback movement is stable by registration order and ID.
 */
export class FocusGraph implements Disposable {
  #records = new Map<string, FocusRecord>();
  #overlays: OverlayRecord[] = [];
  #activeTargetId: string | undefined;
  #disposedTargetId: string | undefined;
  #generation = 0;
  #nextOrder = 0;
  #disposed = false;

  get snapshot(): FocusGraphSnapshot {
    const targets = [...this.#records.values()]
      .sort((left, right) => left.order - right.order || compareText(left.target.id, right.target.id))
      .map((record) => Object.freeze({
        id: record.target.id,
        kind: record.target.kind,
        contexts: Object.freeze([...record.target.contexts]),
        edges: Object.freeze([...record.edges.entries()]
          .sort((left, right) => compareText(left[0], right[0]))
          .map(([direction, targetId]) => Object.freeze({ direction, targetId }))),
      }));
    return Object.freeze({
      generation: this.#generation,
      activeTargetId: this.#activeTargetId,
      targets: Object.freeze(targets),
      overlayDepth: this.#overlays.length,
    });
  }

  register(target: FocusTarget, options: FocusRegistrationOptions = {}): Result<Disposable, FocusGraphFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'graph-disposed' } };
    const valid = validateTarget(target);
    if (!valid.ok) return valid;
    if (this.#records.has(target.id)) return { ok: false, error: { kind: 'duplicate-target', targetId: target.id } };
    const edges = new Map<FocusDirection, string>();
    for (const edge of options.edges ?? []) {
      if (!isFocusDirection(edge.direction) || !isIdentifier(edge.targetId)) {
        return { ok: false, error: { kind: 'invalid-target', message: `invalid focus edge for ${target.id}` } };
      }
      if (edges.has(edge.direction)) {
        return { ok: false, error: { kind: 'duplicate-edge', targetId: target.id, direction: edge.direction } };
      }
      edges.set(edge.direction, edge.targetId);
    }
    const record: FocusRecord = { target, order: this.#nextOrder, edges };
    this.#nextOrder += 1;
    this.#records.set(target.id, record);
    // Edges may point forward, but cannot resolve to a disposed/unknown node
    // when traversed. Validate the complete graph at movement time so nodes
    // can be registered in any deterministic order.
    if (options.focus === true || this.#activeTargetId === undefined) this.#activeTargetId = target.id;
    this.#disposedTargetId = undefined;
    this.#generation += 1;
    const handle = new FocusHandle(() => this.remove(target.id));
    return { ok: true, value: handle };
  }

  /** Register and focus a transient overlay, remembering the prior valid focus. */
  openOverlay(target: FocusTarget): Result<Disposable, FocusGraphFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'graph-disposed' } };
    const previousTargetId = this.#activeTargetId;
    const registered = this.register(target, { focus: true });
    if (!registered.ok) return registered;
    const registration = registered.value as FocusHandle;
    const overlay: OverlayRecord = { targetId: target.id, previousTargetId, registration };
    this.#overlays.push(overlay);
    this.#generation += 1;
    return {
      ok: true,
      value: new FocusHandle(() => {
        this.dismissOverlay(target.id);
      }),
    };
  }

  focus(targetId: string): Result<void, FocusGraphFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'graph-disposed' } };
    const record = this.#records.get(targetId);
    if (record === undefined) {
      if (this.#disposedTargetId === targetId) return { ok: false, error: { kind: 'target-disposed', targetId } };
      return { ok: false, error: { kind: 'missing-target', targetId } };
    }
    this.#activeTargetId = targetId;
    this.#disposedTargetId = undefined;
    this.#generation += 1;
    return { ok: true, value: undefined };
  }

  move(direction: FocusDirection): Result<string, FocusGraphFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'graph-disposed' } };
    if (!isFocusDirection(direction)) return { ok: false, error: { kind: 'invalid-target', message: 'unknown focus direction' } };
    const active = this.#activeTargetId === undefined ? undefined : this.#records.get(this.#activeTargetId);
    if (active === undefined) {
      if (this.#disposedTargetId !== undefined) return { ok: false, error: { kind: 'target-disposed', targetId: this.#disposedTargetId } };
      return { ok: false, error: { kind: 'missing-target', targetId: '' } };
    }
    const explicit = active.edges.get(direction);
    if (explicit !== undefined) {
      const result = this.focus(explicit);
      return result.ok ? { ok: true, value: explicit } : result;
    }
    const ordered = [...this.#records.values()]
      .sort((left, right) => left.order - right.order || compareText(left.target.id, right.target.id));
    const index = ordered.findIndex((record) => record.target.id === active.target.id);
    if (index < 0 || ordered.length < 2) return { ok: true, value: active.target.id };
    const step = direction === 'previous' || direction === 'left' || direction === 'up' ? -1 : 1;
    const next = ordered[(index + step + ordered.length) % ordered.length];
    if (next === undefined) return { ok: true, value: active.target.id };
    const focused = this.focus(next.target.id);
    return focused.ok ? { ok: true, value: next.target.id } : focused;
  }

  activeTarget(): FocusTarget | undefined {
    return this.#activeTargetId === undefined ? undefined : this.#records.get(this.#activeTargetId)?.target;
  }

  activeState():
    | { readonly kind: 'active'; readonly target: FocusTarget }
    | { readonly kind: 'disposed'; readonly targetId: string }
    | { readonly kind: 'empty' } {
    const target = this.activeTarget();
    if (target !== undefined) return { kind: 'active', target };
    if (this.#disposedTargetId !== undefined) return { kind: 'disposed', targetId: this.#disposedTargetId };
    return { kind: 'empty' };
  }

  /** Dismisses the top overlay and restores its previous focus if it remains. */
  dismissOverlay(targetId?: string): boolean {
    const index = targetId === undefined
      ? this.#overlays.length - 1
      : this.#overlays.findIndex((item) => item.targetId === targetId);
    if (index < 0) return false;
    const overlay = this.#overlays[index];
    if (overlay === undefined) return false;
    this.#overlays.splice(index, 1);
    overlay.registration.dispose();
    const prior = overlay.previousTargetId;
    if (prior !== undefined && this.#records.has(prior)) {
      this.#activeTargetId = prior;
      this.#disposedTargetId = undefined;
    } else {
      this.#activeTargetId = this.firstTargetId();
    }
    this.#generation += 1;
    return true;
  }

  firstTargetId(): string | undefined {
    const first = [...this.#records.values()].sort((left, right) => left.order - right.order || compareText(left.target.id, right.target.id))[0];
    return first?.target.id;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#records.clear();
    this.#overlays = [];
    this.#activeTargetId = undefined;
    this.#generation += 1;
  }

  private remove(targetId: string): void {
    const record = this.#records.get(targetId);
    if (record === undefined) return;
    this.#records.delete(targetId);
    const overlayIndex = this.#overlays.findIndex((item) => item.targetId === targetId);
    if (overlayIndex >= 0) this.#overlays.splice(overlayIndex, 1);
    if (this.#activeTargetId === targetId) {
      this.#disposedTargetId = targetId;
      this.#activeTargetId = undefined;
    }
    this.#generation += 1;
  }
}

class FocusHandle implements Disposable {
  #active = true;
  readonly #onDispose: () => void;

  constructor(onDispose: () => void) { this.#onDispose = onDispose; }

  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#onDispose();
  }
}

function validateTarget(target: FocusTarget): Result<void, FocusGraphFailure> {
  if (target === null || typeof target !== 'object' || !isIdentifier(target.id)
    || !isFocusTargetKind(target.kind) || !Array.isArray(target.contexts)
    || target.contexts.length === 0 || !target.contexts.every(isIdentifier)
    || (target.handleInput !== undefined && typeof target.handleInput !== 'function')) {
    return { ok: false, error: { kind: 'invalid-target', message: 'focus targets require an ID, kind and context' } };
  }
  return { ok: true, value: undefined };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0');
}

function isFocusDirection(value: unknown): value is FocusDirection {
  return value === 'next' || value === 'previous' || value === 'left' || value === 'right' || value === 'up' || value === 'down';
}

function isFocusTargetKind(value: unknown): value is FocusTargetKind {
  return value === 'editor' || value === 'panel' || value === 'overlay' || value === 'picker' || value === 'status';
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
