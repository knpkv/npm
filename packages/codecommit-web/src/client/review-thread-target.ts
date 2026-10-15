/** Stable, selector-safe DOM targets for normalized review threads. @module */
import type { ReviewThread } from "@knpkv/review"

export type ReviewThreadTarget = Pick<ReviewThread, "source" | "id">

/**
 * Pass one shared scope to the index and cards, unique to this workspace/presentation. Encode the
 * full [scope, source, id] tuple, so provider punctuation or Unicode never becomes selector syntax.
 * The host opens the secondary group before focusing a secondary target with getElementById.
 */
export const reviewThreadElementId = (scope: string, thread: ReviewThreadTarget): string =>
  `review-thread-${
    Array.from(new TextEncoder().encode(JSON.stringify([scope, thread.source, thread.id])), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`
