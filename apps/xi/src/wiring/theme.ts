import { CancellationSource } from '../../../../packages/primitives/src/entrypoints/launch';
import { ThemeController } from '../../../../packages/workbench/src/entrypoints/launch';
import type { WorkbenchTheme } from '../../../../packages/ui/src/entrypoints/launch';
import { BUILTIN_WORKBENCH_THEMES } from '../../../../packages/ui/src/entrypoints/theme';
import type { NodeFilesystemPort } from '../../../../packages/platform/src/entrypoints/launch';
import { EditorStatePersistence, decodeHelixWorkbenchTheme } from '../../../../packages/services/src/entrypoints/config';
import type { ThemeConfig } from '../../../../packages/services/src/entrypoints/theme';
import type { StatusMessageController } from '../../../../packages/workbench/src/entrypoints/launch';

/** Legacy user config, custom themes and the read-only theme migration source live here.
 * New editor state is written to ~/.xi.toml. */
export function themeStateDirectory(): string {
  return `${process.env.HOME ?? process.cwd()}/.config/xi`;
}
export function themeStatePath(): string {
  return `${themeStateDirectory()}/state.json`;
}

/** The service owns Helix parsing, palette resolution and inheritance; this composition root
 * only assigns its structurally compatible result into the UI launch type. */
function workbenchThemeFromConfig(theme: ThemeConfig): WorkbenchTheme {
  return decodeHelixWorkbenchTheme(theme);
}

interface LoadedCustomTheme { readonly label: string; readonly theme: WorkbenchTheme; }

/** Discover user theme.toml files under ~/.config/xi/themes/, and adapt the parsed token
 * tables (owned by `packages/services/config`'s `discoverCustomThemeConfigs`) into the UI's
 * `WorkbenchTheme` launch shape -- the one piece of this that is composition-root wiring, not
 * a services-owned algorithm, since only the app knows the UI's launch type. */
async function discoverCustomThemes(filesystem: NodeFilesystemPort, cancellation: CancellationSource, statusMessages: StatusMessageController): Promise<ReadonlyMap<string, LoadedCustomTheme>> {
  const directory = `${themeStateDirectory()}/themes`;
  const { discoverCustomThemeConfigs } = await import('../../../../packages/services/src/entrypoints/theme');
  const { themes: discovered, diagnostics } = await discoverCustomThemeConfigs(filesystem, directory, cancellation.token);
  for (const diagnostic of diagnostics) statusMessages.publish(`xi: ${diagnostic.message}`);
  const themes = new Map<string, LoadedCustomTheme>();
  for (const [id, discoveredTheme] of discovered) {
    themes.set(id, { label: id, theme: workbenchThemeFromConfig(discoveredTheme.theme) });
  }
  return themes;
}

async function loadCustomTheme(filesystem: NodeFilesystemPort, cancellation: CancellationSource, statusMessages: StatusMessageController, id: string): Promise<LoadedCustomTheme | undefined> {
  const directory = `${themeStateDirectory()}/themes`;
  const { loadCustomThemeConfig } = await import('../../../../packages/services/src/entrypoints/theme');
  const { theme, diagnostics } = await loadCustomThemeConfig(filesystem, directory, id, cancellation.token);
  for (const diagnostic of diagnostics) statusMessages.publish(`xi: ${diagnostic.message}`);
  return theme === undefined ? undefined : { label: theme.id, theme: workbenchThemeFromConfig(theme.theme) };
}

export interface ThemeWiring {
  readonly editorState: EditorStatePersistence;
  readonly themeController: ThemeController<WorkbenchTheme>;
  readonly persistedThemeId: string | undefined;
  loadCustomTheme(id: string): Promise<boolean>;
  loadCustomThemes(): Promise<void>;
  disposeStateCancellation(): void;
}

/** Constructs the theme controller and loads only a persisted custom selection before the
 * first frame. The full picker catalog loads after that frame. */
export async function createThemeWiring(filesystem: NodeFilesystemPort, statusMessages: StatusMessageController): Promise<ThemeWiring> {
  const editorState = new EditorStatePersistence(filesystem, `${process.env.HOME ?? process.cwd()}/.xi.toml`, message => statusMessages.publish(message));
  const themeStateCancellation = new CancellationSource();
  const themeController = new ThemeController<WorkbenchTheme>({
    initial: new Map(Object.entries(BUILTIN_WORKBENCH_THEMES)),
    defaultId: 'xi-light',
    persistSelection: async id => { editorState.setTheme(id); await editorState.flush(); },
    filesystem,
    statePath: themeStatePath(),
    stateDirectory: themeStateDirectory(),
    onPersistError: (message) => statusMessages.publish(`xi: ${message}`),
  });
  const persistedThemeId = await themeController.readPersistedId(themeStateCancellation.token);
  const loadCustomThemeById = async (id: string): Promise<boolean> => {
    if (themeController.has(id)) return true;
    const custom = await loadCustomTheme(filesystem, themeStateCancellation, statusMessages, id);
    if (custom === undefined) return false;
    themeController.addCustomTheme(id, custom.label, custom.theme);
    return true;
  };
  const loadCustomThemes = async (): Promise<void> => {
    for (const [customId, custom] of await discoverCustomThemes(filesystem, themeStateCancellation, statusMessages)) {
      themeController.addCustomTheme(customId, custom.label, custom.theme);
    }
  };
  if (persistedThemeId !== undefined && !themeController.has(persistedThemeId)) await loadCustomThemeById(persistedThemeId);
  if (persistedThemeId !== undefined && themeController.has(persistedThemeId)) themeController.setActiveId(persistedThemeId);
  return {
    editorState,
    themeController,
    persistedThemeId,
    loadCustomTheme: loadCustomThemeById,
    loadCustomThemes,
    disposeStateCancellation: () => themeStateCancellation.dispose(),
  };
}
