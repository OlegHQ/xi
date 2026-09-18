import type { ViewId } from '../../contracts/src/index';
import type { WorkbenchSession } from '../session';
import { scrollViewBy, type ScrollCursorSession } from '../pointer/scroll';

/** Host commandIds this module executes. Also passed to `compileConfig`'s command catalog
 * (apps/xi/src/main.ts) so config validation accepts bindings targeting them. */
export const VIEW_COMMAND_IDS = Object.freeze([
  'view.scroll-up', 'view.scroll-down', 'view.scroll-page-up', 'view.scroll-page-down',
  'view.half-page-up', 'view.half-page-down',
] as const);
export type ViewCommandId = typeof VIEW_COMMAND_IDS[number];

export function isViewCommandId(value: string): value is ViewCommandId {
  return (VIEW_COMMAND_IDS as readonly string[]).includes(value);
}

/** `<C-Up>`/`<C-Down>` line-scroll in Normal/Visual are on by default; `bindings` (compiled
 * from the user's config) is consulted first and can override or add to this. */
export const DEFAULT_VIEW_BINDINGS: readonly { readonly mode: string; readonly token: string; readonly commandId: ViewCommandId }[] = Object.freeze([
  { mode: 'normal', token: '<c-up>', commandId: 'view.scroll-up' },
  { mode: 'normal', token: '<c-down>', commandId: 'view.scroll-down' },
  { mode: 'visual', token: '<c-up>', commandId: 'view.scroll-up' },
  { mode: 'visual', token: '<c-down>', commandId: 'view.scroll-down' },
]);

export interface ViewCommandContext {
  readonly workbench: Pick<WorkbenchSession, 'readView' | 'setViewScroll'>;
  readonly getSession: (viewId: ViewId) => ScrollCursorSession | undefined;
  readonly viewId: ViewId;
  readonly viewportHeight: number | undefined;
  /** Lines per `view.scroll-up`/`view.scroll-down` step; from `editor.mouse.scrollLines`. */
  readonly scrollLines: number;
}

/** Executes one of `VIEW_COMMAND_IDS`; returns whether it applied (the view exists). */
export function executeViewCommand(commandId: ViewCommandId, context: ViewCommandContext): boolean {
  const { workbench, getSession, viewId, viewportHeight, scrollLines } = context;
  const page = Math.max(1, viewportHeight ?? 1);
  const delta = commandId === 'view.scroll-up' ? -scrollLines
    : commandId === 'view.scroll-down' ? scrollLines
    : commandId === 'view.scroll-page-up' ? -page
    : commandId === 'view.scroll-page-down' ? page
    : commandId === 'view.half-page-up' ? -Math.ceil(page / 2)
    : Math.ceil(page / 2); // view.half-page-down
  return scrollViewBy(workbench, getSession, viewId, delta, viewportHeight) !== undefined;
}
