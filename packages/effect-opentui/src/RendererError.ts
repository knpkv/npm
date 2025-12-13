/**
 * Error types for effect-opentui.
 */
import { Data } from "effect"

/**
 * Error that occurs during renderer operations.
 *
 * @category errors
 */
export class RendererError extends Data.TaggedError("RendererError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * Error that occurs during keyboard input handling.
 *
 * @category errors
 */
export class KeyboardError extends Data.TaggedError("KeyboardError")<{
  readonly reason: string
}> {}
