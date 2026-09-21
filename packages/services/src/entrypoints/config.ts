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
  workspaceTrustAllows,
} from '../../config/index';
export type {
  CompiledConfig,
  ConfigLayer,
  ConfigCompileResult,
  FormatterEnvironmentSelection,
  HelixWorkbenchThemeTokens,
  LanguageConfig,
  LanguageServerConfig,
  ClipboardCommandConfig,
  ClipboardProviderConfig,
  LoadedStartupConfig,
  RequiredWorkbenchThemeTokens,
  StartupConfigFilesystemPort,
  WorkspaceTrustConfig,
  WorkspaceTrustDecision,
  WorkspaceTrustResolver,
  WorkbenchThemeTokens,
} from '../../config/index';

export { EditorStatePersistence } from '../../config/state';
