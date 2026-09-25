import type { RGBA } from '@opentui/core/renderer';
import type { SyntaxTokenKind } from '../../contracts/src/index';

export type ThemeColor = string | RGBA;

/** Mirrors Helix's style table without pulling configuration ownership into the UI package. */
export interface HelixThemeStyle {
  readonly fg?: string;
  readonly bg?: string;
  readonly modifiers?: readonly string[];
  readonly underline?: { readonly color?: string; readonly style?: string };
}

/** Theme values stay data-only here. The renderer materializes terminal palette intent. */
export interface WorkbenchTheme {
  readonly background: ThemeColor;
  readonly surface: ThemeColor;
  readonly surfaceActive: ThemeColor;
  readonly foreground: ThemeColor;
  readonly muted: ThemeColor;
  readonly border: ThemeColor;
  readonly accent: ThemeColor;
  readonly error: ThemeColor;
  /** Optional editor layer tokens. Existing themes receive stable defaults. */
  readonly selectionPrimary?: ThemeColor;
  readonly selectionSecondary?: ThemeColor;
  readonly cursorPrimary?: ThemeColor;
  readonly cursorSecondary?: ThemeColor;
  /** Cursor background when the cursor's cell also lies inside a visual selection. */
  readonly cursorOnSelection?: ThemeColor;
  readonly motionTrail?: ThemeColor;
  readonly operatorPreview?: ThemeColor;
  /** Background of workspace-search matches painted in the editor. */
  readonly searchMatch?: ThemeColor;
  /** Git diff view: added/removed line backgrounds and the hunk-header foreground. Unset
   * themes fall back to stable defaults in `packages/ui/git/diff.ts`. */
  readonly diffAdded?: ThemeColor;
  readonly diffRemoved?: ThemeColor;
  readonly diffHunk?: ThemeColor;
  /** Optional per-kind syntax foreground colors; unset kinds paint with the plain foreground. */
  readonly syntax?: Partial<Record<SyntaxTokenKind, ThemeColor>>;
  /** Per-kind Helix syntax style, including background and terminal attributes. */
  readonly syntaxStyles?: Readonly<Record<string, HelixThemeStyle>>;
  /** Fully resolved Helix scope map. New paint sites consume this first; scalar fields above
   * are compatibility defaults for existing renderer interfaces. */
  readonly styles?: Readonly<Record<string, HelixThemeStyle>>;
}

/** Helix resolves a dotted scope using the longest available prefix. */
export function helixThemeStyle(theme: WorkbenchTheme, scope: string): HelixThemeStyle | undefined {
  let candidate = scope;
  while (candidate.length > 0) {
    const style = theme.styles?.[candidate];
    if (style !== undefined) return style;
    candidate = candidate.slice(0, candidate.lastIndexOf('.'));
  }
  return undefined;
}

const LIGHT_SYNTAX_COLORS: Partial<Record<SyntaxTokenKind, string>> = Object.freeze({
  comment: '#8A8FA0',
  string: '#3B8A3E',
  number: '#C25A00',
  keyword: '#7C3AED',
  boolean: '#1F5FBF',
  type: '#5B6ABF',
  function: '#1F5FBF',
  operator: '#1A8A8F',
  punctuation: '#4C5566',
  variable: '#1E2430',
  property: '#B02A45',
  constant: '#B02A45',
});

const DARK_SYNTAX_COLORS: Partial<Record<SyntaxTokenKind, string>> = Object.freeze({
  comment: '#6C7086',
  string: '#A6E3A1',
  number: '#FAB387',
  keyword: '#CBA6F7',
  boolean: '#89B4FA',
  type: '#F9E2AF',
  function: '#89B4FA',
  operator: '#94E2D5',
  punctuation: '#9399B2',
  variable: '#CDD6F4',
  property: '#F38BA8',
  constant: '#FAB387',
});

/** Warm, high-contrast light theme: near-white paper, cool blue accent, amber motion trail. */
export const LIGHT_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#FCFCFA',
  surface: '#F1F2F5',
  surfaceActive: '#E2E8F2',
  foreground: '#1E2430',
  muted: '#5B6572',
  border: '#D6DCE5',
  accent: '#1F5FBF',
  error: '#C0392B',
  selectionPrimary: '#CFE1FA',
  selectionSecondary: '#E1EBF9',
  cursorPrimary: '#14202E',
  cursorSecondary: '#3F5670',
  cursorOnSelection: '#6D3BB5',
  motionTrail: '#FFEDB3',
  operatorPreview: '#F6C7C2',
  searchMatch: '#F5E3A1',
  syntax: LIGHT_SYNTAX_COLORS,
});

export const ASCII_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  ...LIGHT_WORKBENCH_THEME,
  border: '#5B6572',
});

/** Catppuccin-Mocha-inspired dark theme: deep navy base, lavender/blue accents. */
export const DARK_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#1E1E2E',
  surface: '#181825',
  surfaceActive: '#313244',
  foreground: '#CDD6F4',
  muted: '#A6ADC8',
  border: '#3A3B4F',
  accent: '#89B4FA',
  error: '#F38BA8',
  selectionPrimary: '#45475A',
  selectionSecondary: '#313244',
  cursorPrimary: '#F5E0DC',
  cursorSecondary: '#B4BEFE',
  cursorOnSelection: '#CBA6F7',
  motionTrail: '#4A3D63',
  operatorPreview: '#6B3A46',
  searchMatch: '#5E5230',
  syntax: DARK_SYNTAX_COLORS,
});

/** Xi's own high-contrast blue-green palette for dark terminals. */
export const OCEAN_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#11212B', surface: '#1A303B', surfaceActive: '#294957',
  foreground: '#EAF3F4', muted: '#B9CED3', border: '#58737B',
  accent: '#84D7F0', error: '#FFAAA5',
  selectionPrimary: '#355768', selectionSecondary: '#294653',
  cursorPrimary: '#FFE5B4', cursorSecondary: '#A6DEE8', cursorOnSelection: '#F4C891',
  motionTrail: '#4A4535', operatorPreview: '#623D42', searchMatch: '#5D563A',
  syntax: Object.freeze({ comment: '#A8C0BD', string: '#A9E0B2', number: '#F4C08B', keyword: '#C6B9EF', boolean: '#8CD8EA', type: '#E2D89B', function: '#8CD8EA', operator: '#A1D5C4', punctuation: '#C4D8D8', variable: '#EAF3F4', property: '#F3B2B2', constant: '#F4C08B' }),
});

/** Xi's own warm-paper palette for light terminals. */
export const PAPER_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#FFF9EC', surface: '#F3EAD8', surfaceActive: '#EADDC4',
  foreground: '#292824', muted: '#625E55', border: '#B5A78E',
  accent: '#165F8D', error: '#A83232',
  selectionPrimary: '#C5DFE9', selectionSecondary: '#DDEBE7',
  cursorPrimary: '#263B4E', cursorSecondary: '#455A4D', cursorOnSelection: '#634674',
  motionTrail: '#F8E4B0', operatorPreview: '#F4CFC5', searchMatch: '#F2DA90',
  syntax: Object.freeze({ comment: '#6A695E', string: '#306D45', number: '#96521C', keyword: '#653F94', boolean: '#155B81', type: '#66558E', function: '#155B81', operator: '#28696C', punctuation: '#5F5A50', variable: '#292824', property: '#913C4A', constant: '#96521C' }),
});

/** Builtin themes selectable at runtime, keyed by the id used in EditorConfig.theme and the
 * theme picker's entries. */
export const BUILTIN_WORKBENCH_THEMES: Readonly<Record<string, WorkbenchTheme>> = Object.freeze({
  'xi-light': LIGHT_WORKBENCH_THEME,
  'xi-dark': DARK_WORKBENCH_THEME,
  'xi-ocean': OCEAN_WORKBENCH_THEME,
  'xi-paper': PAPER_WORKBENCH_THEME,
});
