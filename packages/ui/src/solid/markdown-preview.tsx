/** @jsxImportSource @opentui/solid */
import { useRenderer, type JSX } from '@opentui/solid';
import { SyntaxStyle, type MarkdownRenderable, type ScrollBoxRenderable } from '@opentui/core';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable, ViewId } from '../../../contracts/src/index';
import type { WorkbenchReadPort } from '../../../workbench/src/index';
import type { WorkbenchTheme } from '../workbench';
import { helixThemeColor } from '../workbench';
import { themeColor } from '../../theme/color-input';
import type { SolidThemeBridge } from './composition';

export interface MarkdownPreviewProps {
  readonly pane: { readonly viewId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workbench: WorkbenchReadPort;
  readonly theme: SolidThemeBridge<WorkbenchTheme>;
  readonly requestFrame: () => void;
  readonly subscribeFrame: ((listener: () => void) => Disposable) | undefined;
  readonly schedule: (task: () => void) => Disposable;
}

/** Native OpenTUI rendering; Vim remains the document/selection owner behind this view. */
export default function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  const [theme, setTheme] = createSignal(props.theme.current());
  const [content, setContent] = createSignal('');
  const [message, setMessage] = createSignal('Markdown preview · Space p: source');
  let markdown: MarkdownRenderable | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  let documentKey = '';
  let generation = 0;
  let task: Disposable | undefined;
  let priorLine: number | undefined;
  let pendingScroll: 'top' | 'bottom' | number | undefined;
  const renderer = useRenderer();
  const [style, setStyle] = createSignal(SyntaxStyle.fromStyles({}));
  const retiredStyles = new Set<SyntaxStyle>();
  const releaseStyles = () => { for (const retired of retiredStyles) retired.destroy(); retiredStyles.clear(); };
  renderer.on('frame', releaseStyles);
  const themeSubscription = props.theme.subscribe(next => {
    setTheme(next);
    const nextStyle = SyntaxStyle.fromStyles({});
    const fg = themeColor(next.foreground, 'fg');
    const accent = themeColor(next.accent, 'fg');
    nextStyle.registerStyle('default', { fg });
    nextStyle.registerStyle('markup.heading', { fg: accent, bold: true });
    for (let level = 1; level <= 6; level += 1) nextStyle.registerStyle(`markup.heading.${level}`, { fg: accent, bold: true });
    nextStyle.registerStyle('markup.strong', { fg, bold: true });
    nextStyle.registerStyle('markup.italic', { fg, italic: true });
    nextStyle.registerStyle('markup.link.label', { fg: accent, underline: true });
    nextStyle.registerStyle('markup.link.url', { fg: themeColor(next.muted, 'fg') });
    nextStyle.registerStyle('markup.raw', { fg: themeColor(helixThemeColor(next, 'markup.raw', 'fg', next.foreground), 'fg') });
    retiredStyles.add(style());
    setStyle(nextStyle);
    if (markdown !== undefined) markdown.syntaxStyle = nextStyle;
    props.requestFrame();
  });

  const update = () => {
    const view = props.workbench.readView(props.pane.viewId as ViewId);
    if (view === undefined) return;
    const snapshot = view.document;
    const key = `${snapshot.id}:${snapshot.version}`;
    if (key !== documentKey) {
      documentKey = key;
      const current = ++generation;
      task?.dispose();
      setContent('');
      priorLine = undefined;
      setMessage('Markdown preview · Loading… · Space p: source');
      const chunks: string[] = [];
      let offset = 0;
      const read = () => {
        if (current !== generation) return;
        let end = Math.min(snapshot.lengthUtf16, offset + 65_536);
        let result = snapshot.slice(offset as never, end as never);
        if (!result.ok && result.error.kind === 'surrogate-split') result = snapshot.slice(offset as never, --end as never);
        if (!result.ok) { setMessage('Markdown preview · Unable to read document · Space p: source'); return; }
        chunks.push(result.value);
        offset = end;
        if (offset < snapshot.lengthUtf16) { task = props.schedule(read); return; }
        // Only publish a complete, current snapshot. Parsing belongs to OpenTUI.
        const live = props.workbench.readView(props.pane.viewId as ViewId);
        if (live?.document.id !== snapshot.id || live.document.version !== snapshot.version) return;
        setContent(chunks.join(''));
        setMessage('Markdown preview · Space p: source');
        pendingScroll = priorLine === 0 ? 'top' : priorLine === snapshot.lineCount - 1 ? 'bottom' : view.scrollTop;
        props.requestFrame();
      };
      task = props.schedule(read);
    }
    const head = view.selections.members.find(member => member.id === view.selections.primaryId)?.head;
    const position = head === undefined ? undefined : snapshot.lineIndexAt(head.at.offset);
    if (position?.ok === true) {
      const line = Number(position.value);
      if (line !== priorLine) {
        pendingScroll = line === 0 ? 'top' : line === snapshot.lineCount - 1 ? 'bottom' : (scroll?.scrollTop ?? view.scrollTop) + line - (priorLine ?? line);
        priorLine = line;
      }
    }
    if (scroll !== undefined && pendingScroll !== undefined && content() !== '') {
      scroll.scrollTo(pendingScroll === 'top' ? 0 : pendingScroll === 'bottom' ? scroll.scrollHeight : pendingScroll);
      pendingScroll = undefined;
    }
  };
  const frameSubscription = props.subscribeFrame?.(update);
  update();
  onCleanup(() => { generation += 1; task?.dispose(); frameSubscription?.dispose(); themeSubscription.dispose(); renderer.off('frame', releaseStyles); releaseStyles(); style().destroy(); });
  return (
    <box position="absolute" left={props.pane.x} top={props.pane.y} width={props.pane.width} height={props.pane.height} zIndex={2} paddingX={2} backgroundColor={themeColor(theme().background, 'bg')} flexDirection="column">
      <text height={1} content={message()} fg={themeColor(theme().muted, 'fg')} />
      <scrollbox ref={node => { scroll = node; }} width="100%" flexGrow={1} scrollX={false} scrollY={true} viewportCulling={true}>
        <markdown ref={node => { markdown = node; }} width="100%" content={content()} syntaxStyle={style()} conceal={true} concealCode={false} fg={themeColor(theme().foreground, 'fg')} bg={themeColor(theme().background, 'bg')} />
      </scrollbox>
    </box>
  );
}
