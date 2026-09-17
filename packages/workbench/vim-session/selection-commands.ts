import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { VimMode, VimSelectionCommand } from '../../vim/src/entrypoints/launch';

export const SELECTION_HISTORY_LIMIT = 100;

export interface XiSelectionCommandInput {
  readonly command: VimSelectionCommand;
  readonly pattern?: string;
  readonly limit?: number;
  readonly ignoreCase?: boolean;
}

export function parseXiSelectionCommand(source: string): XiSelectionCommandInput | undefined {
  const match = /^xi\s+(selection\.[a-z-]+)(?:\s+([\s\S]*))?$/iu.exec(source);
  if (match === null) return undefined;
  const command = match[1] as VimSelectionCommand;
  if (!SELECTION_COMMANDS.has(command)) return undefined;
  const argument = match[2]?.trim() ?? '';
  if (PATTERN_SELECTION_COMMANDS.has(command)) {
    if (argument.length === 0) return { command };
    const flags = /\s+--(ignore-case|limit=\d+)$/u.exec(argument);
    const pattern = flags === null ? argument : argument.slice(0, flags.index).trimEnd();
    const limitFlag = flags?.[1]?.startsWith('limit=') === true ? Number(flags[1].slice('limit='.length)) : undefined;
    return {
      command,
      ...(pattern.length === 0 ? {} : { pattern }),
      ...(flags?.[1] === 'ignore-case' ? { ignoreCase: true } : {}),
      ...(limitFlag === undefined ? {} : { limit: limitFlag }),
    };
  }
  if (argument.length !== 0) return undefined;
  return { command };
}

export const SELECTION_COMMANDS: ReadonlySet<string> = new Set([
  'selection.add-above', 'selection.add-below', 'selection.add-next-match', 'selection.skip-next-match',
  'selection.select-all-matches', 'selection.split-lines', 'selection.select-regex', 'selection.keep-matching',
  'selection.remove-primary', 'selection.keep-primary', 'selection.rotate-primary-next',
  'selection.rotate-primary-previous', 'selection.collapse', 'selection.flip', 'selection.merge', 'selection.undo',
]);

export const PATTERN_SELECTION_COMMANDS: ReadonlySet<VimSelectionCommand> = new Set([
  'selection.add-next-match', 'selection.skip-next-match', 'selection.select-all-matches',
  'selection.select-regex', 'selection.keep-matching',
]);

export function selectionModeFor(kind: SelectionSetSnapshot['members'][number]['kind'] | undefined): VimMode {
  switch (kind) {
    case 'insert-caret': return 'insert';
    case 'visual-character': return 'visual-character';
    case 'visual-line': return 'visual-line';
    case 'visual-block': return 'visual-block';
    case 'normal-cursor':
    default: return 'normal';
  }
}
