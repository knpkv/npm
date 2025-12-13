/**
 * ScrollBox component wrapper for OpenTUI ScrollBoxRenderable.
 */
import { ScrollBoxRenderable } from "@opentui/core"
import { Effect } from "effect"
import { Renderer } from "../Renderer.ts"

/**
 * Configuration for ScrollBox component.
 *
 * @category models
 */
export interface ScrollBoxConfig {
  readonly id: string
  readonly x?: number
  readonly y?: number
  readonly width?: number | string
  readonly height?: number | string
  readonly flexGrow?: number
  readonly border?: boolean
  readonly borderStyle?: "single" | "double" | "rounded"
  readonly scrollBarVisible?: boolean
  readonly [key: string]: unknown
}

/**
 * Creates a ScrollBox component.
 *
 * @category constructors
 */
export const ScrollBox = (config: ScrollBoxConfig): Effect.Effect<ScrollBoxRenderable, never, Renderer> =>
  Effect.gen(function*() {
    const { cli } = yield* Renderer
    return new ScrollBoxRenderable(cli, config)
  })
