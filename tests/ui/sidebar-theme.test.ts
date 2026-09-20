import assert from 'node:assert/strict';
import { parseColor } from '@opentui/core/renderer';
import { sidebarTheme, readableSidebarForeground } from '../../packages/ui/theme/sidebar';
import { contrastRatio } from '../../packages/ui/theme/motion-tokens';
import { LIGHT_WORKBENCH_THEME, type WorkbenchTheme } from '../../packages/ui/theme/workbench-themes';

// Resolved Catppuccin Latte values: popup/menu surface0 must not color the sidebar.
const theme: WorkbenchTheme = {
  ...LIGHT_WORKBENCH_THEME, background: '#eff1f5', foreground: '#4c4f69', surface: '#ccd0da',
  surfaceActive: '#bcc0cc', muted: '#8c8fa1', selectionPrimary: '#bcc0cc',
  styles: { 'ui.menu': { bg: '#ccd0da', fg: '#7c7f93' }, 'ui.text.focus': { bg: '#ccd0da' }, 'ui.cursorline.primary': { bg: '#e8ecf1' } },
};
const sidebar = sidebarTheme(theme);
assert.equal(sidebar.surface, '#eff1f5');
assert.equal(sidebar.foreground, '#4c4f69');
assert.equal(sidebar.muted, sidebar.foreground);
assert.equal(sidebarTheme(theme), sidebar, 'palette adaptation is cached off the paint loop');
assert.equal(sidebar.styles, theme.styles, 'Helix scopes are not rewritten');
for (const bg of [sidebar.surface, sidebar.surfaceActive, sidebar.selectionSecondary!]) {
  assert.ok(contrastRatio(parseColor(sidebar.foreground), parseColor(bg)) >= 4.5);
  assert.ok(contrastRatio(parseColor(sidebar.muted), parseColor(bg)) >= 4.5);
}
assert.equal(readableSidebarForeground('#df8e1d', '#4c4f69', ['#ccd0da']), '#4c4f69', 'unreadable colored labels retain a readable glyph');
console.log('Sidebar Latte normal/selected/hover text contrast and source-scope preservation passed');
