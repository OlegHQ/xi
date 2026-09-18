/** Config file parsing loads only at startup, off the keystroke path. */
export {
  compileConfig,
  DEFAULT_COMMAND_CATALOG,
  DEFAULT_CONFIG_TOML,
  decodeRequiredWorkbenchThemeTokens,
  loadStartupXiConfig,
  resolveFormatOnSave,
  resolveFormatterSelection,
} from '../../config/index';
export type {
  CompiledConfig,
  ConfigLayer,
  ConfigCompileResult,
  FormatterEnvironmentSelection,
  LanguageConfig,
  LanguageServerConfig,
  LoadedStartupConfig,
  RequiredWorkbenchThemeTokens,
  StartupConfigFilesystemPort,
} from '../../config/index';
