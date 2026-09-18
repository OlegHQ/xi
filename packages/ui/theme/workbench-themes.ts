import type { SyntaxTokenKind } from '../../contracts/src/index';

/** Pure theme tokens: no OpenTUI import, so the CLI can read them before the renderer loads. */
export interface WorkbenchTheme {
  readonly background: string;
  readonly surface: string;
  readonly surfaceActive: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly error: string;
  /** Optional editor layer tokens. Existing themes receive stable defaults. */
  readonly selectionPrimary?: string;
  readonly selectionSecondary?: string;
  readonly cursorPrimary?: string;
  readonly cursorSecondary?: string;
  /** Cursor background when the cursor's cell also lies inside a visual selection. */
  readonly cursorOnSelection?: string;
  readonly motionTrail?: string;
  readonly operatorPreview?: string;
  /** Optional per-kind syntax foreground colors; unset kinds paint with the plain foreground. */
  readonly syntax?: Partial<Record<SyntaxTokenKind, string>>;
}

const LIGHT_SYNTAX_COLORS: Partial<Record<SyntaxTokenKind, string>> = Object.freeze({
  comment: '#6A737D',
  string: '#22863A',
  number: '#B08800',
  keyword: '#D73A49',
  boolean: '#005CC5',
  type: '#6F42C1',
  function: '#6F42C1',
  operator: '#D73A49',
  punctuation: '#24292E',
  variable: '#24292E',
  property: '#005CC5',
  constant: '#005CC5',
});

const DARK_SYNTAX_COLORS: Partial<Record<SyntaxTokenKind, string>> = Object.freeze({
  comment: '#7F8C98',
  string: '#98C379',
  number: '#D19A66',
  keyword: '#E06C75',
  boolean: '#56B6C2',
  type: '#C678DD',
  function: '#C678DD',
  operator: '#E06C75',
  punctuation: '#D8DEE9',
  variable: '#D8DEE9',
  property: '#56B6C2',
  constant: '#56B6C2',
});

export const LIGHT_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#FAF9F6',
  surface: '#F1F0EC',
  surfaceActive: '#E7EDF4',
  foreground: '#24292E',
  muted: '#60666D',
  border: '#D5D4CF',
  accent: '#245A88',
  error: '#A52A36',
  selectionPrimary: '#D6E5F2',
  selectionSecondary: '#E4ECF3',
  cursorPrimary: '#1A2835',
  cursorSecondary: '#405B72',
  cursorOnSelection: '#6B3FA0',
  motionTrail: '#EEF2F4',
  operatorPreview: '#C4D8E8',
  syntax: LIGHT_SYNTAX_COLORS,
});

export const ASCII_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  ...LIGHT_WORKBENCH_THEME,
  border: '#60666D',
});

export const DARK_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#1E2126',
  surface: '#262A31',
  surfaceActive: '#2E3440',
  foreground: '#D8DEE9',
  muted: '#8B93A1',
  border: '#3B4048',
  accent: '#6FA8DC',
  error: '#E06C75',
  selectionPrimary: '#3B4A5A',
  selectionSecondary: '#2E3A47',
  cursorPrimary: '#D8DEE9',
  cursorSecondary: '#8B93A1',
  cursorOnSelection: '#C792EA',
  motionTrail: '#2A2E35',
  operatorPreview: '#3E5670',
  syntax: DARK_SYNTAX_COLORS,
});

/** Builtin themes selectable at runtime, keyed by the id used in EditorConfig.theme and the
 * theme picker's entries. */
export const BUILTIN_WORKBENCH_THEMES: Readonly<Record<string, WorkbenchTheme>> = Object.freeze({
  'xi-light': LIGHT_WORKBENCH_THEME,
  'xi-dark': DARK_WORKBENCH_THEME,
});
