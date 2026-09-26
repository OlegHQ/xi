/** @jsxImportSource @opentui/solid */
import type { CliRenderer, CliRendererErrorEvent } from '@opentui/core';
import { render } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import { ErrorBoundary, Show, createSignal, onCleanup } from 'solid-js';
import type { MouseEvent } from '@opentui/core/renderer';

export type SolidNode = () => JSX.Element;

function ErrorDialog(props: { readonly error: unknown; readonly retry: () => void }): JSX.Element {
  return <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={250} backgroundColor="#1e1e2e" padding={2} flexDirection="column">
    <text height={1} flexShrink={0} content="Xi UI error" fg="#f38ba8" />
    <scrollbox flexGrow={1} flexShrink={1} minHeight={1} scrollX={false}>
      <text content={props.error instanceof Error ? props.error.stack ?? props.error.message : String(props.error)} fg="#cdd6f4" wrapMode="word" />
    </scrollbox>
    <text height={1} flexShrink={0} content="Click here to retry · :q to quit" fg="#89b4fa" onMouse={event => { if (event.type === 'down' && event.button === 0) props.retry(); }} />
  </box>;
}

function SolidRoot(props: { readonly renderer: CliRenderer; readonly nodes: readonly SolidNode[]; readonly onPointer?: (event: MouseEvent) => void }): JSX.Element {
  let root!: object;
  const [renderError, setRenderError] = createSignal<Error>();
  const reportRenderError = (event: CliRendererErrorEvent) => { setRenderError(event.error); props.renderer.requestRender(); };
  props.renderer.on('render:error', reportRenderError);
  onCleanup(() => props.renderer.off('render:error', reportRenderError));
  return (
    <box ref={node => { root = node; }} onMouse={event => {
      if (event.target === root) props.onPointer?.(event);
    }} position="absolute" left={0} top={0} width="100%" height="100%" zIndex={1}>
      <Show when={renderError()} keyed fallback={
        <ErrorBoundary fallback={(error: unknown, reset: () => void) => <ErrorDialog error={error} retry={reset} />}>
          {props.nodes.map(node => node())}
        </ErrorBoundary>
      }>{(error: Error) => <ErrorDialog error={error} retry={() => setRenderError(undefined)} />}</Show>
    </box>
  );
}

export async function mountSolidRoot(renderer: CliRenderer, nodes: readonly SolidNode[], onPointer?: (event: MouseEvent) => void): Promise<void> {
  await render(() => <SolidRoot renderer={renderer} nodes={nodes} {...(onPointer === undefined ? {} : { onPointer })} />, renderer);
}
