import type { Result } from '../../contracts/src/index';

export interface PersistedSelectionMember { readonly id: string; readonly anchor: number; readonly head: number; readonly kind: string; }
export interface PersistedViewSelection { readonly viewId: string; readonly documentId: string; readonly contentHash: string; readonly documentVersion: number; readonly scrollTop: number; readonly scrollLeft: number; readonly primaryId: string; readonly members: readonly PersistedSelectionMember[]; }
export interface SelectionPersistenceSnapshot { readonly schemaVersion: 1; readonly views: readonly PersistedViewSelection[]; }
export type SelectionPersistenceFailure = { readonly kind: 'invalid' | 'unknown-schema' | 'changed-content' | 'closed-view'; readonly message: string };

export class ViewSelectionPersistence {
  encode(views: readonly PersistedViewSelection[]): Result<Uint8Array, SelectionPersistenceFailure> { const checked: PersistedViewSelection[] = []; for (const view of views) { const result = validateView(view); if (!result.ok) return result; checked.push(result.value); } const value: SelectionPersistenceSnapshot = Object.freeze({ schemaVersion: 1, views: Object.freeze(checked) }); return { ok: true, value: new TextEncoder().encode(JSON.stringify(value)) }; }
  decode(bytes: Uint8Array): Result<SelectionPersistenceSnapshot, SelectionPersistenceFailure> { let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch { return { ok: false, error: { kind: 'invalid', message: 'selection snapshot is not valid UTF-8 JSON' } }; } if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1) return { ok: false, error: { kind: 'unknown-schema', message: 'selection snapshot schema is not supported' } }; if (!('views' in value) || !Array.isArray(value.views)) return { ok: false, error: { kind: 'invalid', message: 'selection snapshot views are invalid' } }; const views: PersistedViewSelection[] = []; for (const item of value.views) { const checked = validateView(item); if (!checked.ok) return checked; views.push(checked.value); } return { ok: true, value: Object.freeze({ schemaVersion: 1, views: Object.freeze(views) }) }; }
  restore(snapshot: SelectionPersistenceSnapshot, context: { readonly openViewIds: ReadonlySet<string>; readonly contentHashes: ReadonlyMap<string, string> }): Result<readonly PersistedViewSelection[], SelectionPersistenceFailure> { const output: PersistedViewSelection[] = []; for (const view of snapshot.views) { if (!context.openViewIds.has(view.viewId)) return { ok: false, error: { kind: 'closed-view', message: `view ${view.viewId} is not open` } }; if (context.contentHashes.get(view.documentId) !== view.contentHash) return { ok: false, error: { kind: 'changed-content', message: `document ${view.documentId} changed since persistence` } }; output.push(view); } return { ok: true, value: Object.freeze(output) }; }
}

function validateView(input: unknown): Result<PersistedViewSelection, SelectionPersistenceFailure> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: { kind: 'invalid', message: 'view selection must be an object' } };
  const candidate = input as Record<string, unknown>;
  const viewId = candidate.viewId; const documentId = candidate.documentId; const contentHash = candidate.contentHash; const documentVersion = candidate.documentVersion; const scrollTop = candidate.scrollTop; const scrollLeft = candidate.scrollLeft; const primaryId = candidate.primaryId; const rawMembers = candidate.members;
  const validVersion = typeof documentVersion === 'number' && Number.isSafeInteger(documentVersion) ? documentVersion : undefined;
  if (typeof viewId !== 'string' || typeof documentId !== 'string' || typeof contentHash !== 'string' || validVersion === undefined || typeof scrollTop !== 'number' || typeof scrollLeft !== 'number' || typeof primaryId !== 'string' || !Array.isArray(rawMembers)) return { ok: false, error: { kind: 'invalid', message: 'view selection fields are invalid' } };
  const members: PersistedSelectionMember[] = [];
  for (const raw of rawMembers) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: { kind: 'invalid', message: 'selection member is invalid' } };
    const member = raw as Record<string, unknown>; const id = member.id; const anchor = member.anchor; const head = member.head; const kind = member.kind;
    const validAnchor = typeof anchor === 'number' && Number.isSafeInteger(anchor) && anchor >= 0 ? anchor : undefined;
    const validHead = typeof head === 'number' && Number.isSafeInteger(head) && head >= 0 ? head : undefined;
    if (typeof id !== 'string' || validAnchor === undefined || validHead === undefined || typeof kind !== 'string') return { ok: false, error: { kind: 'invalid', message: 'selection member coordinates are invalid' } };
    members.push(Object.freeze({ id, anchor: validAnchor, head: validHead, kind }));
  }
  if (!members.some((member) => member.id === primaryId)) return { ok: false, error: { kind: 'invalid', message: 'primary selection is missing' } };
  return { ok: true, value: Object.freeze({ viewId, documentId, contentHash, documentVersion: validVersion, scrollTop, scrollLeft, primaryId, members: Object.freeze(members) }) };
}
