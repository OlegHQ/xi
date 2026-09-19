/** @jsxImportSource @opentui/solid */
import type { CliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';

export type SolidNode = () => JSX.Element;

function SolidRoot(props: { readonly nodes: readonly SolidNode[]; readonly onPointer?: (event: MouseEvent) => void }): JSX.Element {
  let root!: object;
  return (
    <box ref={node => { root = node; }} onMouse={event => {
      if (event.target === root) props.onPointer?.(event);
    }} position="absolute" left={0} top={0} width="100%" height="100%" zIndex={1}>
      {props.nodes.map(node => node())}
    </box>
  );
}

export async function mountSolidRoot(renderer: CliRenderer, nodes: readonly SolidNode[], onPointer?: (event: MouseEvent) => void): Promise<void> {
  await render(() => <SolidRoot nodes={nodes} {...(onPointer === undefined ? {} : { onPointer })} />, renderer);
}
