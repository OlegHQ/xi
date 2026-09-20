import type { CliRenderer, KeyEvent } from '@opentui/core/renderer';
import type { Disposable, SyntaxReadPort } from '../../contracts/src/index.ts';
import type { EditorPresentationReadPort } from '../editor/motion-paint';
import type { WorkbenchReadPort } from '../../workbench/src/index.ts';
import type { PrefixHelpReadPort } from '../help/index';
import type { PickerReadPort } from '../picker/index';
import type { ExplorerReadPort } from '../explorer/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../workbench/src/entrypoints/launch';
import type { SearchReadPort, SearchUiState } from '../search/index';
import type { GitReadPort } from '../git/index';
import type { ProblemsReadPort } from '../problems/index';
import type { GitDiffReadPort } from '../git/diff';
import type { TaskOutputReadPort } from '../output/index';
import type { OutlineReadPort, HierarchyReadPort, HoverReadPort } from '../navigation/index';
import type { CompletionReadPort, SignatureReadPort } from '../completion/index';
import type { ExCommandLineReadPort } from '../commandline/index';
import type { StatusMessageReadPort } from '../status/index';
import type { DirectoryDraftReadPort } from '../directory/index';
import type { WorkbenchPanelPointerEvent } from './panel-pointer';
import type { ContextMenuStore } from './context-menu';
import type { WorkbenchPointerEvent, WorkbenchTheme } from './workbench';

export interface OpenTuiWorkbenchOptions {
  readonly comparison?: import('../git/editor').ComparisonReadPort;
  /** Renderer creation may begin while the application composes its workbench. */
  readonly renderer?: Promise<CliRenderer>;
  /** Called after the first frame starts; nonessential services may activate here. */
  readonly onReady?: () => void | Promise<void>;
  /**
   * Hands the application a toggle for the renderer's own mouse-reporting mode, so a documented
   * keybinding can flip it and let the terminal's native click-drag text selection work again.
   * The callback returns the mode's new enabled state.
   */
  readonly registerMouseToggle?: (toggle: () => boolean) => void;
  /** Hands the application a live theme setter, so a documented keybinding/picker action can
   * repaint the whole workbench with a new theme immediately (preview), and revert it just as
   * immediately (cancel) -- no renderer teardown/recreation involved. */
  readonly registerThemeSwitch?: (setTheme: (theme: WorkbenchTheme) => void) => void;
  /**
   * Hands the application the renderer-side half of terminal job control (Ctrl-Z/`fg`):
   * `suspend` releases pointer capture and stops the renderer painting; `resume` starts it
   * painting again. The platform layer owns the actual `SIGTSTP`/`SIGCONT` handling and the
   * process's own `SIGSTOP`; this adapter never touches process signals directly.
   */
  readonly registerJobControl?: (control: { readonly suspend: () => void; readonly resume: () => void }) => void;
  /** The theme every renderable surface starts painted with, before any picker interaction --
   * e.g. a persisted selection restored at launch. Defaults to the built-in light theme. */
  readonly theme?: WorkbenchTheme;
  /** Read-only syntax spans for the editor viewport; see `WorkbenchRenderableOptions.syntax`. */
  readonly syntax?: SyntaxReadPort;
  /** Optional editor presentation read (workspace-search match highlights, previews); see
   * `WorkbenchRenderableOptions.presentation`. */
  readonly presentation?: EditorPresentationReadPort;
  /** Current Git branch for the status line; undefined hides it. */
  readonly gitBranch?: () => string | undefined;
  /** Live sidebar section/width read model; see `WorkbenchRenderableOptions.sidebar`. Also
   * used to bound `getExplorerBounds`'s sidebar-docked region below the section headers. */
  readonly sidebar?: () => SidebarReadModel;
  /** Live buffer tab strip; see `WorkbenchRenderableOptions.tabs`. */
  readonly tabs?: (viewId?: string) => readonly WorkbenchTabSnapshot[];
  /** Wake panels whose read ports become available after an asynchronous open. */
  readonly subscribeSurfaceChanges?: (listener: () => void) => Disposable;
  /** Forwarded to the main viewport renderable; see `WorkbenchRenderableOptions.onViewportAnchorChange`. */
  readonly onViewportAnchorChange?: (viewId: string, scrollTop: number, scrollLeft: number) => void;
  /** Forwarded to the main viewport renderable; see `WorkbenchRenderableOptions.onViewportSizeChange`. */
  readonly onViewportSizeChange?: (viewId: string, heightCells: number) => void;
  /**
   * H1-7: `WorkbenchInputRouter.dispatchKey`, handed in by `apps/xi/src/wiring/ui.ts`. This is
   * the *only* thing `processKeypress` calls for a keypress -- the router owns the ordered
   * overlay-focus stack (context menu, command line, completion, picker, explorer, search,
   * problems, output, outline, hierarchy, hover, directory review, signature) plus its own
   * fallthrough; `packages/ui` holds no second copy of that precedence policy. Required: a
   * caller that wants to drive keyboard input through this adapter supplies a router (a real
   * one, or a test double implementing the same dispatch contract).
   */
  readonly dispatchKey: (event: KeyEvent) => 'consumed' | 'pending' | 'unhandled' | 'quit' | Promise<'consumed' | 'pending' | 'unhandled' | 'quit'>;
  /** Bracketed-paste bytes, delivered as one opaque event; never re-parsed as keystrokes. */
  readonly onPaste?: (bytes: Uint8Array) => void;
  /** Optional editor pointer route; semantic placement remains application-owned. */
  readonly onPointer?: (event: WorkbenchPointerEvent) => boolean;
  readonly onPointerCancel?: (reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void;
  /** Diagnostic hook invoked after an explicit intermediate frame completes. */
  readonly onFrame?: () => void;
  /** Optional test/diagnostic marker sink; replaces a direct env-var/stderr write so the
   * platform layer decides whether and how a marker is emitted. */
  readonly marker?: (name: string, payload?: unknown) => void;
  /** Optional passive parser/help read model. It never receives keyboard focus. */
  readonly prefixHelp?: PrefixHelpReadPort;
  /** Optional right-click context menu state; the application owns items/activation. */
  readonly contextMenu?: ContextMenuStore;
  /** Optional read-only picker surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly picker?: {
    readonly read: PickerReadPort;
    readonly isOpen: () => boolean;
    readonly onViewportRows?: (rows: number) => void;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
    /** Helix-style preview of the selected file entry (title + leading lines), if any. */
    readonly preview?: () => { readonly title: string; readonly lines: readonly string[] } | undefined;
  };
  /** Optional focused Explorer surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly explorer?: {
    readonly read: ExplorerReadPort;
    readonly isOpen: () => boolean;
    readonly isFocused?: () => boolean;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
    readonly prompt?: () => string | undefined;
  };
  /** Optional workspace search surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly search?: {
    readonly read: SearchReadPort;
    readonly isOpen: () => boolean;
    readonly selectedId?: () => string | undefined;
    /** Live panel mode/replace draft/collapsed groups (`SearchController.uiState`). */
    readonly state?: () => SearchUiState;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional docked Git (Source Control) panel; keyboard routing lives in
   * `WorkbenchInputRouter`. */
  readonly git?: {
    readonly read: GitReadPort;
    readonly isOpen: () => boolean;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional read-only diagnostics surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly problems?: {
    readonly read: ProblemsReadPort;
    readonly isOpen: () => boolean;
    readonly selectedId?: () => string | undefined;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional Git diff view, painted over the editor rectangle; keyboard routing lives in
   * `WorkbenchInputRouter`. */
  readonly gitDiff?: {
    readonly read: GitDiffReadPort;
    readonly isOpen: () => boolean;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
    readonly onScroll?: (delta: number) => void;
    /** Bounds are set by the terminal, not read back by it -- this is how the diff view's
     * own unified/side-by-side layout choice learns the editor rectangle's current size. */
    readonly onViewportChange?: (width: number, height: number) => void;
  };
  /** Optional read-only task output surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly output?: {
    readonly read: TaskOutputReadPort;
    readonly isOpen: () => boolean;
  };
  /** Optional read-only language outline; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly outline?: {
    readonly read: OutlineReadPort;
    readonly isOpen: () => boolean;
  };
  /** Optional lazy hierarchy surface; host owns expansion, cancellation and link actions. */
  readonly hierarchy?: {
    readonly read: HierarchyReadPort;
    readonly isOpen: () => boolean;
  };
  /** Optional read-only hover surface; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly hover?: {
    readonly read: HoverReadPort;
    readonly isOpen: () => boolean;
  };
  /**
   * Optional directory-draft review surface (a rename/move/copy plan before it is applied).
   * The UI never applies or closes it; keyboard routing (including the one case where an
   * unhandled key falls through to a lower-priority surface) lives in `WorkbenchInputRouter`.
   */
  readonly directoryReview?: {
    readonly read: DirectoryDraftReadPort;
    readonly isOpen: () => boolean;
  };
  /** Optional insert-mode completion popup; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly completion?: {
    readonly read: CompletionReadPort;
    readonly isOpen: () => boolean;
  };
  /** Optional signature help popup; keyboard routing lives in `WorkbenchInputRouter`. */
  readonly signature?: {
    readonly read: SignatureReadPort;
    readonly isOpen: () => boolean;
  };
  /** Focused Ex command line; parsing, execution and keyboard routing live in `WorkbenchInputRouter`. */
  readonly commandLine?: {
    readonly read: ExCommandLineReadPort;
    readonly isOpen: () => boolean;
  };
  /** Latest feature-reported status/error message (formatter, git, LSP, save, ...); shares the
   * command line's idle bottom row so it renders through OpenTUI instead of raw stderr. */
  readonly statusMessage?: { readonly read: StatusMessageReadPort };
}
