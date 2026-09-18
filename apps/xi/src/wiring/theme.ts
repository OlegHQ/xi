import { CancellationSource } from '../../../../packages/primitives/src/entrypoints/launch';
import { ThemeController } from '../../../../packages/workbench/src/entrypoints/launch';
import type { WorkbenchTheme } from '../../../../packages/ui/src/entrypoints/launch';
import { BUILTIN_WORKBENCH_THEMES } from '../../../../packages/ui/src/entrypoints/theme';
import type { NodeFilesystemPort } from '../../../../packages/platform/src/entrypoints/launch';
import { decodeRequiredWorkbenchThemeTokens } from '../../../../packages/services/src/entrypoints/config';

/** The standard XDG-style `~/.config/xi/` convention every config file (theme state,
 * config.toml, languages.toml) lives under; never throws, since a missing/unreadable/corrupt
 * file must never block startup. */
export function themeStateDirectory(): string {
  return `${process.env.HOME ?? process.cwd()}/.config/xi`;
}
export function themeStatePath(): string {
  return `${themeStateDirectory()}/state.json`;
}

/** Build a full WorkbenchTheme from a parsed theme.toml's free-form token table, requiring
 * every core field explicitly (never partially applies) -- returns undefined, not a
 * partially-filled theme, if any required token is missing.
 * Token names use the dotted, lowercase convention packages/services/config/index.ts's own
 * DEFAULT_THEME_TOML and tests/config/t036-config.test.ts already established for the optional
 * editor-layer tokens (selection.primary, cursor.primary, motion.trail, operator.preview) --
 * extended with the same style for the required base surface tokens, which that example never
 * covered. A flat/camelCase-named theme.toml is deliberately rejected, not silently accepted
 * under two incompatible naming schemes. */
function workbenchThemeFromTokens(tokens: Readonly<Record<string, string>>): WorkbenchTheme | undefined {
  const required = decodeRequiredWorkbenchThemeTokens(tokens);
  if (!required.ok) return undefined;
  const { background, surface, foreground, muted, border, accent, error } = required.value;
  return Object.freeze({
    background, surface, surfaceActive: required.value['surface.active'], foreground, muted, border, accent, error,
    ...(tokens['selection.primary'] === undefined ? {} : { selectionPrimary: tokens['selection.primary'] }),
    ...(tokens['selection.secondary'] === undefined ? {} : { selectionSecondary: tokens['selection.secondary'] }),
    ...(tokens['cursor.primary'] === undefined ? {} : { cursorPrimary: tokens['cursor.primary'] }),
    ...(tokens['cursor.secondary'] === undefined ? {} : { cursorSecondary: tokens['cursor.secondary'] }),
    ...(tokens['motion.trail'] === undefined ? {} : { motionTrail: tokens['motion.trail'] }),
    ...(tokens['operator.preview'] === undefined ? {} : { operatorPreview: tokens['operator.preview'] }),
  });
}

interface LoadedCustomTheme { readonly label: string; readonly theme: WorkbenchTheme; }

/** Discover user theme.toml files under ~/.config/xi/themes/, and adapt the parsed token
 * tables (owned by `packages/services/config`'s `discoverCustomThemeConfigs`) into the UI's
 * `WorkbenchTheme` launch shape -- the one piece of this that is composition-root wiring, not
 * a services-owned algorithm, since only the app knows the UI's launch type. */
async function discoverCustomThemes(filesystem: NodeFilesystemPort, cancellation: CancellationSource): Promise<ReadonlyMap<string, LoadedCustomTheme>> {
  const directory = `${themeStateDirectory()}/themes`;
  const { discoverCustomThemeConfigs } = await import('../../../../packages/services/src/entrypoints/theme');
  const { themes: discovered, diagnostics } = await discoverCustomThemeConfigs(filesystem, directory, cancellation.token);
  for (const diagnostic of diagnostics) process.stderr.write(`xi: ${diagnostic.message}\n`);
  const themes = new Map<string, LoadedCustomTheme>();
  for (const [id, discoveredTheme] of discovered) {
    const theme = workbenchThemeFromTokens(discoveredTheme.tokens);
    if (theme === undefined) {
      process.stderr.write(`xi: theme file ${id}.toml is missing one or more required tokens (background, surface, surface.active, foreground, muted, border, accent, error)\n`);
      continue;
    }
    themes.set(id, { label: discoveredTheme.name, theme });
  }
  return themes;
}

export interface ThemeWiring {
  readonly themeController: ThemeController<WorkbenchTheme>;
  readonly persistedThemeId: string | undefined;
  readonly needsCustomThemeNow: boolean;
  loadCustomThemes(): Promise<void>;
  disposeStateCancellation(): void;
}

/** Constructs the theme controller, reads the persisted active theme id and (only when that
 * persisted theme is a custom one, not a builtin) loads custom themes before the first frame;
 * otherwise custom themes load after the first frame for the picker via `loadCustomThemes()`. */
export async function createThemeWiring(filesystem: NodeFilesystemPort): Promise<ThemeWiring> {
  const themeStateCancellation = new CancellationSource();
  const themeController = new ThemeController<WorkbenchTheme>({
    initial: new Map(Object.entries(BUILTIN_WORKBENCH_THEMES)),
    defaultId: 'xi-light',
    filesystem,
    statePath: themeStatePath(),
    stateDirectory: themeStateDirectory(),
    onPersistError: (message) => process.stderr.write(`xi: ${message}\n`),
  });
  const persistedThemeId = await themeController.readPersistedId(themeStateCancellation.token);
  const loadCustomThemes = async (): Promise<void> => {
    for (const [customId, custom] of await discoverCustomThemes(filesystem, themeStateCancellation)) {
      themeController.addCustomTheme(customId, custom.label, custom.theme);
    }
  };
  const needsCustomThemeNow = persistedThemeId !== undefined && !themeController.has(persistedThemeId);
  if (needsCustomThemeNow) await loadCustomThemes();
  if (persistedThemeId !== undefined && themeController.has(persistedThemeId)) themeController.setActiveId(persistedThemeId);
  return {
    themeController,
    persistedThemeId,
    needsCustomThemeNow,
    loadCustomThemes,
    disposeStateCancellation: () => themeStateCancellation.dispose(),
  };
}
