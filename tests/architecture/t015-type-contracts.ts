import type { ViewId } from '../../packages/primitives/src/index';
import type { UiMountContext } from '../../packages/ui/src/index';
import { ViewportLayout, type LayoutFrameId } from '../../packages/layout/src/index';

declare const layout: ViewportLayout;
declare const frameId: LayoutFrameId;
declare const rawOffset: number;
declare const mountContext: UiMountContext;
declare const viewId: ViewId;

const readDocument = mountContext.workbench.readDocument(viewId);
// @ts-expect-error ARCH-UI-READ-ONLY-01: UI receives a document read port, not a mutation port.
readDocument?.commit({});
// @ts-expect-error ARCH-COORDINATE-UNIT-01: a raw number does not identify a UTF-16 offset.
layout.positionForOffset(frameId, rawOffset);
