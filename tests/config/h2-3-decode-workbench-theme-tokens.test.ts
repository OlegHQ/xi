import assert from 'node:assert/strict';
import { decodeWorkbenchThemeTokens } from '../../packages/services/config/index';

// H2-3: theme.toml token decoding (required base surface tokens + whichever optional
// editor-layer tokens are present) used to live in apps/xi/src/wiring/theme.ts even though the
// required half already lived in packages/services/config. decodeWorkbenchThemeTokens now owns
// the full decode so the app only assigns the result into the UI's WorkbenchTheme launch type.

const REQUIRED = Object.freeze({
  background: '#111111',
  surface: '#222222',
  'surface.active': '#333333',
  foreground: '#eeeeee',
  muted: '#999999',
  border: '#444444',
  accent: '#00aaff',
  error: '#ff0000',
});

const full = decodeWorkbenchThemeTokens(REQUIRED);
assert.notEqual(full, undefined, 'H2-3-01 a token table with every required base surface token decodes');
assert.equal(full!.background, '#111111', 'H2-3-02 required tokens pass through');
assert.equal(full!.surfaceActive, '#333333', 'H2-3-03 the dotted surface.active token maps to the camelCase field');
assert.equal(full!.selectionPrimary, undefined, 'H2-3-04 an absent optional token stays absent, not a partial empty string');

const withOptional = decodeWorkbenchThemeTokens({ ...REQUIRED, 'selection.primary': '#abcdef', 'motion.trail': '#123456' });
assert.notEqual(withOptional, undefined, 'H2-3-05 optional tokens alongside required ones still decode');
assert.equal(withOptional!.selectionPrimary, '#abcdef', 'H2-3-06 selection.primary maps to selectionPrimary');
assert.equal(withOptional!.motionTrail, '#123456', 'H2-3-07 motion.trail maps to motionTrail');
assert.equal(withOptional!.cursorPrimary, undefined, 'H2-3-08 an optional token never present stays absent');

const { background: _unused, ...missingBackground } = REQUIRED;
void _unused;
assert.equal(decodeWorkbenchThemeTokens(missingBackground), undefined, 'H2-3-09 a missing required token returns undefined, never a partially-filled theme');

console.log('H2-3 decodeWorkbenchThemeTokens decodes required + optional workbench theme tokens and never partially applies');
