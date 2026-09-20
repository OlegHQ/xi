import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { DiagnosticStore } from '../../packages/services/language/diagnostics';
import { StatusMessageController } from '../../packages/workbench/status';
import { DARK_WORKBENCH_THEME, LIGHT_WORKBENCH_THEME } from '../../packages/ui/theme/workbench-themes';
import { Shell } from './components';

const problems = new DiagnosticStore();
const messages = new StatusMessageController({ schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return { dispose: () => clearTimeout(timer) }; } });
problems.publish({ serverId: 'evaluation', uri: 'example.ts', generation: 1, diagnostics: Array.from({ length: 20 }, (_, i) => ({
  range: { startLine: i, startUtf16: 0, endLine: i, endUtf16: 1 },
  message: `Diagnostic ${i + 1} — shared panel row`, severity: i % 2 === 0 ? 1 as const : 2 as const,
  source: 'evaluation', code: undefined,
})) });
const renderer = await createCliRenderer({ screenMode: 'alternate-screen', exitOnCtrlC: false, maxFps: 1000, consoleMode: 'disabled' });
function Demo() {
  const [dark, setDark] = useState(false);
  const [offset, setOffset] = useState(0);
  useKeyboard(key => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) renderer.destroy();
    if (key.name === 't') setDark(value => !value);
    if (key.name === 'j') setOffset(value => Math.min(19, value + 1));
    if (key.name === 'k') setOffset(value => Math.max(0, value - 1));
    if (key.name === 'm') messages.publish('Controller update; only Messages subscribes to this state.', 'info');
  });
  return <Shell theme={dark ? DARK_WORKBENCH_THEME : LIGHT_WORKBENCH_THEME} problems={problems} messages={messages} offset={offset}
    onSelect={id => messages.publish(`Selected ${id}`, 'info')}>
    <text fg={dark ? '#CDD6F4' : '#24292E'}>Editor surface slot — this prototype does not implement editing.</text>
  </Shell>;
}
createRoot(renderer).render(<Demo />);
