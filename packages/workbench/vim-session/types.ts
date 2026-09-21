import type { ClipboardPort, ClockPort, ViewId } from '../../contracts/src/index';
import type { CommittedDocumentChange } from '../../document/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { VimMode } from '../../vim/src/entrypoints/launch';
import type { WorkbenchReadPort } from '../src/read-model';
import type { VimHostCommand, VimInsertOptions } from '../../vim/src/index';
import type { PointerSelectionIntent } from '../../vim/src/entrypoints/launch';
import type { PrefixHelpParserContinuation } from '../commands/prefix-help';

export interface OwnedVimKeyEvent {
  readonly name: string;
  readonly raw: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

export interface OwnedVimSessionOptions {
  readonly viewId: ViewId;
  /** Xi profile: preserve the last motion for explicit Visual adoption. */
  readonly motionGhost?: boolean;
  /** Xi selection safety bound for multi-selection commands. */
  readonly selectionLimit?: number;
  /** Xi bounded history depth for selection-only undo. */
  readonly selectionHistoryLimit?: number;
  /** Helix-compatible destination for an implicit yank; explicit register prefixes win. */
  readonly defaultYankRegister?: string;
  /** Helix master: completed mouse selections are yanked into this Vim register. */
  readonly mouseYankRegister?: string;
  readonly clipboard?: ClipboardPort;
  readonly isActive?: () => boolean;
  /** Helix editor.smart-tab.enable mapped to Vim's existing bounded insert option. */
  readonly insertOptions?: VimInsertOptions;
  /** Monotonic time source for repeat-timing/dot-repeat bookkeeping. Defaults to a
   * performance.now()-backed clock when omitted. */
  readonly clock?: Pick<ClockPort, 'monotonicMilliseconds'>;
  /** Host-owned visible-line range, refreshed by the host each frame, for H/M/L. When
   * omitted, H/M/L fall back to treating the whole document as the viewport. */
  readonly viewport?: {
    readonly topLine: () => number;
    readonly bottomLine: () => number;
  };
  /** Host-owned file identity for the `%` and `#` registers (current and alternate file). */
  readonly files?: {
    readonly currentPath: () => string | undefined;
    readonly alternatePath: () => string | undefined;
  };
  readonly initialLine?: number;
  readonly initialSelections?: SelectionSetSnapshot;
  readonly initialMode?: VimMode;
  readonly onMessage?: (message: string) => void;
  readonly onSave?: (path?: string) => Promise<boolean>;
  /** Give the workbench first refusal for host commands such as split/close. */
  readonly onExCommand?: (source: string) => Promise<'handled' | 'unhandled' | 'quit'> | 'handled' | 'unhandled' | 'quit';
  /** Route host-dependent native commands without putting I/O on the key path. */
  readonly onHostCommand?: (command: VimHostCommand) => void | Promise<void>;
  /** Publish the owned engine state to the workbench after each input event. */
  readonly onStateChange?: (state: { readonly selections: SelectionSetSnapshot; readonly mode: VimMode }) => void;
  /** Publish parser-owned continuation metadata to the passive help surface. */
  readonly onPrefixStateChange?: (state: VimPrefixHelpState) => void;
  /** Publish the command-line source to the read-only Ex surface. */
  readonly onCommandLineChange?: (state: VimCommandLineState | undefined) => void;
  /** Publish each committed document change to language/service owners. */
  readonly onDocumentChange?: (change: CommittedDocumentChange) => void;
}

export interface VimPrefixHelpState {
  readonly pendingKeys: readonly string[];
  readonly parserContinuations: readonly PrefixHelpParserContinuation[];
}

export interface VimCommandLineState {
  /** The leading ':', '/' or '?' is included; cursorOffset is UTF-16 based. */
  readonly source: string;
  readonly cursorOffset: number;
  /** 'search-forward'/'search-backward' distinguish a `/`/`?` prompt from an Ex `:`
   * command line so the UI can render the correct prompt glyph; both still expose the
   * leading character through `source` for a caller that only reads that field. */
  readonly kind: 'ex' | 'search-forward' | 'search-backward';
}

/** The last successful search pattern, and whether a `/`/`?` prompt is currently open, for a
 * later incremental-highlight UI. Cheap: no scanning, just the committed search state. */
export interface VimSearchHighlightState {
  readonly pattern: string;
  readonly active: boolean;
}

export interface OwnedVimSession extends WorkbenchReadPort {
  /** Effective insert indentation for this buffer, formatted for the statusline. */
  readonly indentStyle: string;
  handleKey(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'>;
  clearMotionGhost(): void;
  readonly motionGhost: import('../../vim/src/entrypoints/launch').VimMotionGhost | undefined;
  readonly commandLineActive: boolean;
  readonly commandLine: VimCommandLineState | undefined;
  readonly prefixHelp: VimPrefixHelpState;
  /** The last successful search pattern (if any) and whether a search prompt is open now,
   * so a UI can highlight matches later without this session scanning the buffer itself. */
  readonly searchHighlight: VimSearchHighlightState | undefined;
  /** Re-anchor the engine after a document owner commits an external edit. */
  applyExternalChange(change: CommittedDocumentChange): void;
  /** Close a Vim Insert group before a service-originated edit takes ownership of history. */
  closeInsertUndoGroup(): boolean;
  /** Move the active insert caret after a service inserts a snippet field. */
  setInsertCursor(offset: number): boolean;
  /** Move every insert caret in one selection-only update. */
  setInsertCursors(offsets: ReadonlyMap<string, number>): boolean;
  /** Place the primary cursor at a host-resolved zero-based line/UTF-16 column; Visual extends its anchor. */
  setCursorPosition(line: number, utf16Column?: number): boolean;
  /** Apply a versioned pointer intent after layout has resolved its text target. */
  placePointer(intent: PointerSelectionIntent): boolean;
  /** Cancel a pending Vim prefix before a pointer placement. */
  cancelPendingOperator(): void;
  /** Replace the accepted Ex source while its command line is active. */
  setCommandLineSource(source: string, cursorOffset?: number): boolean;
  /** Execute the displayed Ex source through the owning session. */
  submitCommandLine(source?: string): Promise<boolean | 'quit'>;
  /** Start recording a macro into `register` (see the file-level comment on why this is
   * exposed here rather than through Normal-mode 'q', which Xi already claims to quit).
   * Returns false if not in Normal mode, already recording, or an invalid register. */
  beginMacroRecording(register: string): boolean;
  /** Insert bracketed-paste bytes as one atomic insertion. Only supported while in
   * Insert/Replace/Virtual-replace mode; a Normal-mode paste is a safe no-op for now. */
  handlePaste(bytes: Uint8Array): boolean;
  handleClipboardPaste(selection?: 'clipboard' | 'primary'): Promise<boolean>;
  /** Release pending session state (command line, prefix keys, macro recording, insert
   * session) and stop publishing further state through the option callbacks. Idempotent. */
  dispose(): void;
}
