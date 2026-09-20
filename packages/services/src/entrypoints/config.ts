/** Config file parsing loads only at startup, off the keystroke path. */
export {
  compileConfig,
  DEFAULT_COMMAND_CATALOG,
  DEFAULT_CONFIG_TOML,
  decodeHelixWorkbenchTheme,
  decodeRequiredWorkbenchThemeTokens,
  decodeWorkbenchThemeTokens,
  loadStartupXiConfig,
  resolveFormatOnSave,
  resolveFormatterSelection,
} from '../../config/index';
export type {
  CompiledConfig,
  ConfigLayer,
  ConfigCompileResult,
  FormatterEnvironmentSelection,
  HelixWorkbenchThemeTokens,
  LanguageConfig,
  LanguageServerConfig,
  LoadedStartupConfig,
  RequiredWorkbenchThemeTokens,
  StartupConfigFilesystemPort,
  WorkbenchThemeTokens,
} from '../../config/index';

export { EditorStatePersistence } from '../../config/state';
