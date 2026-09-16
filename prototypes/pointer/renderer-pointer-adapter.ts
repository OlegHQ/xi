import type { MouseEvent } from "@opentui/core";
import {
  normalizeRendererMouse,
  type CanonicalMouseEvent,
} from "../../spikes/input/types.js";

/**
 * Coalesce the pinned renderer's one-packet / many-callback capture lifecycle.
 * This is a T084 experiment, not the production pointer dispatcher.
 */
export class RendererPointerAdapter {
  private capturedReleaseFollowups = 0;

  constructor(private readonly emit: (event: CanonicalMouseEvent) => void) {}

  handle(event: MouseEvent): void {
    switch (event.type) {
      case "over":
      case "out":
        return;
      case "drag-end":
        this.emit({ ...normalizeRendererMouse(event), eventType: "up" });
        // OpenTUI 0.5.11 fans one captured release into drag-end, up, drop,
        // then another up. These are renderer callbacks, not four terminal
        // reports. Ignore the three synchronous follow-ups.
        this.capturedReleaseFollowups = 3;
        return;
      case "up":
      case "drop":
        if (this.capturedReleaseFollowups > 0) {
          this.capturedReleaseFollowups--;
          return;
        }
        if (event.type === "drop") return;
        this.emit(normalizeRendererMouse(event));
        return;
      default:
        this.emit(normalizeRendererMouse(event));
    }
  }
}
