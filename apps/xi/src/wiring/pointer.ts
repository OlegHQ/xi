import type { Controllers } from './controllers';

/** The panel/control registrations that used to sit directly inside main(): the
 * pointer-router's control targets (chevrons/tabs the pointer hit-tests against) and the
 * panel-exclusivity registry (opening one overlay panel must always close every other one).
 * Pulled out of ARCH-COMPOSITION-ROOT-01's composition root into its own call so `main()`
 * only has to invoke it once controllers exist. */
export function wireControllerPanels(controllers: Controllers): void {
  const { pointerRouter, host, sidebarController, explorerFeature, searchFeature, gitPanelFeature, problemsFeature, overlayFeature, completionFeature, directoryDraftController, workbench, picker, gitDiffFeature } = controllers;

  pointerRouter.publishControls([
    // `sidebar.files` is still the Files chevron's own click target (the legacy row-0
    // hit-testing in `workbenchControlAt` keeps the same x-thirds it always had, so
    // `sidebar.search`/`sidebar.git` -- now painted without their own visible labels, see
    // `WorkbenchRenderable#paintSidebar` -- stay reachable at their old coordinates); it now
    // also flips the chrome's own expand/collapse bookkeeping alongside opening the panel.
    // Toggling the chevron now also drives the section's inline content: expanding it opens
    // the panel (so its content actually shows below the header), collapsing it closes the
    // panel (so a collapsed section never leaves a hidden-but-still-open surface behind).
    // Keyed on whether the Explorer currently has focus, not on the section flag: while
    // Search/Git occupy the column, or after opening a file returned focus to the editor,
    // the click means "show me the tree at the current buffer" (open() also reveals it).
    // Only a click on an already-focused tree collapses the section. Toggling the flag
    // blindly collapsed a section whose content was hidden and left the sidebar blank.
    { id: 'sidebar.files', kind: 'tree', enabled: true, activate: () => {
      if (explorerFeature.isOpen) { sidebarController.collapseSection('files'); explorerFeature.hide(); return; }
      sidebarController.expandSection('files');
      explorerFeature.open();
    } },
    { id: 'sidebar.search', kind: 'button', enabled: true, activate: () => searchFeature.open() },
    { id: 'sidebar.git', kind: 'button', enabled: true, activate: () => gitPanelFeature.open() },
    // Row 1 (the `▸ Outline` header) was unused chrome before this ticket, so it is a new,
    // uncontested control id.
    { id: 'sidebar-section.outline', kind: 'button', enabled: true, activate: () => {
      sidebarController.toggleSection('outline');
      if (sidebarController.readModel().sections.find((section) => section.id === 'outline')?.expanded === true) overlayFeature.openOutline();
      else overlayFeature.closeOutline();
      host.notifySurfaceChange();
    } },
    { id: 'status', kind: 'button', enabled: true, activate: () => {} },
    { id: 'tab.active', kind: 'tab', enabled: true, activate: () => { const active = workbench.activeViewId; if (active !== undefined) void workbench.focus(active); } },
  ]);
  /** Every overlay panel is mutually exclusive with every other; opening one must always
   * close the rest, not just the ones a given call site happened to remember. Registered on
   * `host` (not yet extracted into per-feature controllers -- S5-S8) so it, not `main()`,
   * owns exclusivity ordering. */
  host.registerPanel('search', { isOpen: () => searchFeature.isOpen, close: () => searchFeature.close() });
  host.registerPanel('git', { isOpen: () => gitPanelFeature.isOpen, close: () => gitPanelFeature.close() });
  host.registerPanel('explorer', { isOpen: () => explorerFeature.isOpen, close: () => explorerFeature.close() });
  host.registerPanel('picker', { isOpen: () => picker.isOpen, close: () => { void picker.close(true); } });
  host.registerPanel('problems', { isOpen: () => problemsFeature.isProblemsOpen, close: () => problemsFeature.closeProblems() });
  host.registerPanel('outline', { isOpen: () => overlayFeature.isOutlineOpen, close: () => overlayFeature.closeOutline() });
  host.registerPanel('hover', { isOpen: () => overlayFeature.isHoverOpen, close: () => overlayFeature.closeHover() });
  host.registerPanel('completion', { isOpen: () => completionFeature.isCompletionOpen, close: () => completionFeature.closeCompletion(), alwaysClose: true });
  host.registerPanel('signature', { isOpen: () => completionFeature.isSignatureOpen, close: () => completionFeature.closeSignature(), alwaysClose: true });
  host.registerPanel('output', { isOpen: () => problemsFeature.isOutputOpen, close: () => problemsFeature.closeOutput() });
  host.registerPanel('directory-review', { isOpen: () => directoryDraftController.isReviewOpen, close: () => directoryDraftController.closeReview() });
  host.registerPanel('git-diff', { isOpen: () => gitDiffFeature.isOpen, close: () => gitDiffFeature.close() });
}
