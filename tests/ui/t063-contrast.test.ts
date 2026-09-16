import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LIGHT_WORKBENCH_THEME, resolveMotionPaintTokens } from '../../packages/ui/src/index';

const theme = LIGHT_WORKBENCH_THEME;
const paint = resolveMotionPaintTokens(theme);
const checks = [
  { id: 'body-on-background', foreground: theme.foreground, background: theme.background, minimum: 4.5 },
  { id: 'muted-on-surface', foreground: theme.muted, background: theme.surface, minimum: 4.5 },
  { id: 'accent-on-background', foreground: theme.accent, background: theme.background, minimum: 4.5 },
  { id: 'error-on-error-background', foreground: theme.error, background: '#FBEAEC', minimum: 4.5 },
  { id: 'body-on-primary-selection', foreground: theme.foreground, background: paint.selectionPrimary, minimum: 4.5 },
  { id: 'body-on-secondary-selection', foreground: theme.foreground, background: paint.selectionSecondary, minimum: 4.5 },
  // Cursor cells are non-text focus indicators. The painter uses the canvas
  // background as the marker glyph foreground in color modes.
  { id: 'primary-cursor-marker', foreground: theme.background, background: paint.cursorPrimary, minimum: 3 },
  { id: 'secondary-cursor-marker', foreground: theme.background, background: paint.cursorSecondary, minimum: 3 },
] as const;

const results = checks.map((check) => {
  const ratio = contrastRatio(check.foreground, check.background);
  assert.ok(ratio >= check.minimum, `T063-CONTRAST-${check.id} ratio ${ratio.toFixed(2)} >= ${check.minimum.toFixed(2)}`);
  return Object.freeze({ ...check, ratio });
});
const artifact = resolve(process.cwd(), '.artifacts/ui/t063-contrast.json');
await mkdir(resolve(process.cwd(), '.artifacts/ui'), { recursive: true });
await writeFile(artifact, `${JSON.stringify({ schemaVersion: 1, fixture: 'T063-CONTRAST-01', results }, null, 2)}\n`, 'utf8');
console.log(`T063 palette contrast passed ${results.length} body, selection and cursor checks; artifact=${artifact}`);

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(parseHex(foreground));
  const backgroundLuminance = luminance(parseHex(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/iu.exec(value);
  if (match?.[1] === undefined) throw new Error(`invalid theme color: ${value}`);
  return [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16)];
}

function luminance(rgb: readonly [number, number, number]): number {
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
