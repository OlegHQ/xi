import type { ExCommandLineReadModel } from '../../../workbench/src/index.ts';
import type { SidebarReadModel } from '../../../workbench/src/entrypoints/launch';
import { calculateWorkbenchLayout, computeSidebarSectionLayout } from '../workbench';

export type SurfaceBounds = { readonly width: number; readonly height: number; readonly left: number; readonly top: number };

export function getExplorerBounds(width: number, height: number, sidebar?: SidebarReadModel): SurfaceBounds {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  if (layout.sidebarVisible && sidebar !== undefined) {
    const sections = computeSidebarSectionLayout(sidebar, layout.statusRow);
    return { width: layout.sidebarWidth, height: sections.filesContentHeight, left: 0, top: sections.filesContentTop };
  }
  if (layout.sidebarVisible) return { width: layout.sidebarWidth, height: Math.max(1, height), left: 0, top: 0 };
  const panelWidth = Math.max(1, Math.min(60, width - 2));
  const panelHeight = Math.max(1, Math.min(24, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((height - panelHeight) / 2)) };
}

export function getPickerBounds(width: number, height: number): SurfaceBounds {
  const panelWidth = Math.max(20, Math.min(width - 2, Math.max(60, Math.floor(width * 0.9))));
  const panelHeight = Math.max(3, Math.min(height - 2, Math.max(12, Math.floor(height * 0.75))));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((height - panelHeight) / 2)) };
}

export function getSearchBounds(width: number, height: number, sidebar?: SidebarReadModel): SurfaceBounds {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  if (layout.sidebarVisible && sidebar !== undefined) return { width: layout.sidebarWidth, height: Math.max(3, layout.statusRow - 1), left: 0, top: 1 };
  const panelWidth = Math.max(1, Math.min(100, width - 2));
  const panelHeight = Math.max(3, Math.min(14, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((height - panelHeight) / 2)) };
}

export function getGitBounds(width: number, height: number, sidebar?: SidebarReadModel): SurfaceBounds {
  return getSearchBounds(width, height, sidebar);
}

export function getProblemsBounds(width: number, height: number): SurfaceBounds {
  const panelWidth = Math.max(1, Math.min(120, width - 2));
  const panelHeight = Math.max(3, Math.min(12, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, height - panelHeight - 1) };
}

export function getGitDiffBounds(width: number, height: number, sidebar?: SidebarReadModel): SurfaceBounds {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  return { width: layout.editorWidth, height: layout.editorHeight, left: layout.editorX, top: layout.editorTop };
}

export function getOutlineBounds(width: number, height: number): SurfaceBounds {
  const panelWidth = Math.max(1, Math.min(80, width - 2));
  const panelHeight = Math.max(3, Math.min(20, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, width - panelWidth - 1), top: 1 };
}

export function getSidebarOutlineBounds(width: number, height: number, sidebar?: SidebarReadModel): SurfaceBounds {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  if (layout.sidebarVisible && sidebar !== undefined) {
    const sections = computeSidebarSectionLayout(sidebar, layout.statusRow);
    return { width: layout.sidebarWidth, height: sections.outlineContentHeight, left: 0, top: sections.outlineContentTop };
  }
  return getOutlineBounds(width, height);
}

export function getDirectoryReviewBounds(width: number, height: number): SurfaceBounds {
  const panelWidth = Math.max(1, Math.min(110, width - 2));
  const panelHeight = Math.max(3, Math.min(20, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((height - panelHeight) / 2)) };
}

export function popupBoundsAtCursor(
  width: number,
  height: number,
  cursor: { readonly x: number; readonly y: number } | undefined,
  size: { readonly width: number; readonly height: number },
  prefer: 'below' | 'above',
): SurfaceBounds {
  const usableRows = Math.max(1, height - 1);
  const panelWidth = Math.max(1, Math.min(size.width, Math.max(1, width - 2)));
  const panelHeight = Math.max(1, Math.min(size.height, Math.max(1, usableRows - 1)));
  if (cursor === undefined) return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((usableRows - panelHeight) / 2)) };
  const left = Math.max(0, Math.min(cursor.x, width - panelWidth));
  const below = cursor.y + 1;
  const above = cursor.y - panelHeight;
  const fitsBelow = below + panelHeight <= usableRows;
  const fitsAbove = above >= 0;
  const top = prefer === 'below'
    ? fitsBelow ? below : fitsAbove ? above : Math.max(0, usableRows - panelHeight)
    : fitsAbove ? above : fitsBelow ? below : 0;
  return { width: panelWidth, height: panelHeight, left, top };
}

export function getCommandLineBounds(width: number, height: number, model: ExCommandLineReadModel | undefined): SurfaceBounds {
  const panelHeight = Math.max(1, Math.min(height, commandLineContentHeight(model)));
  return { width: Math.max(1, width), height: panelHeight, left: 0, top: Math.max(0, height - panelHeight) };
}

function commandLineContentHeight(model: ExCommandLineReadModel | undefined): number {
  if (model === undefined) return 1;
  if (model.parseFailure !== undefined) return 2;
  const candidateRows = Math.min(model.candidates.length, 8);
  if (candidateRows === 0) return 1;
  const selected = model.candidates[model.selectedIndex];
  return 1 + candidateRows + (selected !== undefined && selected.detail.length > 0 ? 2 : 0);
}

export function getPrefixHelpBounds(width: number, height: number): SurfaceBounds {
  const panelHeight = Math.max(1, Math.min(6, Math.max(1, height - 1)));
  return { width: Math.max(1, width), height: panelHeight, left: 0, top: Math.max(0, height - panelHeight - 1) };
}
