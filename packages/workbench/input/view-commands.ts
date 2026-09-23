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

export interface ViewCommandContext {
  readonly workbench: Pick<WorkbenchSession, 'readView' | 'setViewScroll'>;
  readonly getSession: (viewId: ViewId) => ScrollCursorSession | undefined;
  readonly viewId: ViewId;
  readonly viewportHeight: number | undefined;
  /** Lines per `view.scroll-up`/`view.scroll-down` step; from `editor.mouse.scrollLines`. */
  readonly scrollLines: number;
  /** Cursor margin used while a view-scroll command moves the viewport. */
  readonly scrolloff?: number;
}

/** Executes one of `VIEW_COMMAND_IDS`; returns whether it applied (the view exists). */
export function executeViewCommand(commandId: ViewCommandId, context: ViewCommandContext): boolean {
  const { workbench, getSession, viewId, viewportHeight, scrollLines } = context;
  const page = Math.max(1, viewportHeight ?? 1);
  const delta = commandId === 'view.scroll-up' ? -scrollLines
    : commandId === 'view.scroll-down' ? scrollLines
    : commandId === 'view.scroll-page-up' ? -page
    : commandId === 'view.scroll-page-down' ? page
    : commandId === 'view.half-page-up' ? -Math.max(1, Math.floor(page / 2))
    : Math.max(1, Math.floor(page / 2)); // view.half-page-down
  // Half-page movement is based on the original cursor, before wheel-style clamping.
  if (commandId === 'view.half-page-up' || commandId === 'view.half-page-down') moveCursorBy(workbench, getSession, viewId, delta);
  const scrolled = scrollViewBy(workbench, getSession, viewId, delta, viewportHeight, context.scrolloff);
  if (scrolled === undefined) return false;
  return true;
}

function moveCursorBy(workbench: Pick<WorkbenchSession, 'readView'>, getSession: ViewCommandContext['getSession'], viewId: ViewId, delta: number): void {
  const view = workbench.readView(viewId);
  const session = getSession(viewId);
  const primary = view?.selections.members.find((member) => member.id === view.selections.primaryId);
  if (view === undefined || session === undefined || primary === undefined) return;
  const line = view.document.lineIndexAt(primary.head.at.offset);
  if (!line.ok) return;
  const lineStart = view.document.lineStartOffset(line.value);
  const column = primary.head.kind === 'line' ? primary.desiredColumn.logicalUtf16 ?? 0 : lineStart.ok ? (primary.head.at.offset as number) - (lineStart.value as number) : 0;
  session.setCursorPosition(Math.min(Math.max(0, (line.value as number) + delta), view.document.lineCount - 1), column);
}
