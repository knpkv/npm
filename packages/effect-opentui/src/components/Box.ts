/**
 * Box component wrapper for OpenTUI BoxRenderable.
 */
import { BoxRenderable } from "@opentui/core"
import { Effect } from "effect"
import { Renderer } from "../Renderer.ts"

/**
 * Configuration for Box component.
 *
 * @category models
 */
export interface BoxConfig {
  readonly id: string
  readonly x?: number
  readonly y?: number
  readonly width?: number | string
  readonly height?: number | string
  readonly flexDirection?: "row" | "column"
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly alignItems?: "flex-start" | "flex-end" | "center" | "stretch"
  readonly justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around"
  readonly padding?: number
  readonly margin?: number
  readonly border?: boolean
  readonly borderStyle?: "single" | "double" | "rounded"
  readonly backgroundColor?: string
  readonly [key: string]: unknown
}

/**
 * Creates a Box component.
 *
 * @category constructors
 */
export const Box = (config: BoxConfig): Effect.Effect<BoxRenderable, never, Renderer> =>
  Effect.gen(function*() {
    const { cli } = yield* Renderer
    return new BoxRenderable(cli, config)
  })
