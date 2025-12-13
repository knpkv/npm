/**
 * Text component wrapper for OpenTUI TextRenderable.
 */
import { TextRenderable } from "@opentui/core"
import { Effect } from "effect"
import { Renderer } from "../Renderer.ts"

/**
 * Configuration for Text component.
 *
 * @category models
 */
export interface TextConfig {
  readonly id: string
  readonly content?: string
  readonly x?: number
  readonly y?: number
  readonly width?: number | string
  readonly height?: number | string
  readonly color?: string
  readonly backgroundColor?: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly [key: string]: unknown
}

/**
 * Creates a Text component.
 *
 * @category constructors
 */
export const Text = (config: TextConfig): Effect.Effect<TextRenderable, never, Renderer> =>
  Effect.gen(function*() {
    const { cli } = yield* Renderer
    return new TextRenderable(cli, config)
  })
