import type { ViewId } from '../../contracts/src/index';
import type { WorkbenchSession } from '../session';

/** Minimal vim-session surface `scrollViewBy` needs to keep the cursor inside the viewport
 * after a wheel scroll; satisfied by `OwnedVimSession`. */
export interface ScrollCursorSession {
  setCursorPosition(line: number, utf16Column?: number): boolean;
}

export interface ScrollViewResult {
  readonly scrollTop: number;
}

/** Applies a wheel-scroll `delta` (in lines) to `viewId`'s viewport and pulls the cursor back
 * inside the visible range, matching Vim scroll semantics: the window moves first and the
 * cursor follows only far enough to stay on screen. Returns the new `scrollTop`, or `undefined`
 * when the view does not exist. */
export function scrollViewBy(
  workbench: Pick<WorkbenchSession, 'readView' | 'setViewScroll'>,
  getSession: (viewId: ViewId) => ScrollCursorSession | undefined,
  viewId: ViewId,
  delta: number,
  viewportHeight: number | undefined,
): ScrollViewResult | undefined {
  const view = workbench.readView(viewId);
  if (view === undefined) return undefined;
  const scrollTop = Math.min(Math.max(0, view.scrollTop + delta), Math.max(0, view.document.lineCount - 1));
  workbench.setViewScroll(viewId, scrollTop, view.scrollLeft);
  // Vim scroll semantics: the window moves and the cursor is pulled inside it, so the
  // renderer's cursor-follow does not immediately undo the wheel.
  const session = getSession(viewId);
  const primary = view.selections.members.find((member) => member.id === view.selections.primaryId);
  const cursorLine = primary === undefined ? undefined : view.document.lineIndexAt(primary.head.at.offset);
  if (session !== undefined && cursorLine?.ok === true) {
    const line = cursorLine.value as number;
    const bottom = scrollTop + Math.max(1, viewportHeight ?? 1) - 1;
    const clamped = line < scrollTop ? scrollTop : line > bottom ? bottom : line;
    if (clamped !== line) {
      const lineStart = view.document.lineStartOffset(cursorLine.value);
      const column = lineStart.ok ? (primary!.head.at.offset as number) - (lineStart.value as number) : 0;
      session.setCursorPosition(clamped, column);
    }
  }
  return { scrollTop };
}
