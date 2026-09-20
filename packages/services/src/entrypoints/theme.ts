/** Theme file parsing loads only when discovering custom themes, off the first-frame path. */
export { discoverCustomThemeConfigs, loadCustomThemeConfig, parseThemeConfig, hasRequiredWorkbenchThemeTokens, type ThemeConfig } from '../../config/index';
export type { DiscoveredCustomTheme, ThemeDiscoveryDiagnostic, ThemeDiscoveryFilesystemPort } from '../../config/index';
