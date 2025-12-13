/**
 * Select component wrapper for OpenTUI SelectRenderable.
 */
import { SelectRenderable } from "@opentui/core"
import { Effect } from "effect"
import { Renderer } from "../Renderer.ts"

/**
 * Option for Select component.
 *
 * @category models
 */
export interface SelectOption<T = unknown> {
  readonly name: string
  readonly description?: string
  readonly value: T
}

/**
 * Configuration for Select component.
 *
 * @category models
 */
export interface SelectConfig<T = unknown> {
  readonly id: string
  readonly options?: ReadonlyArray<SelectOption<T>>
  readonly x?: number
  readonly y?: number
  readonly width?: number | string
  readonly height?: number | string
  readonly flexGrow?: number
  readonly border?: boolean
  readonly borderStyle?: "single" | "double" | "rounded"
  readonly [key: string]: unknown
}

/**
 * Creates a Select component.
 *
 * @category constructors
 */
export const Select = <T>(config: SelectConfig<T>): Effect.Effect<SelectRenderable, never, Renderer> =>
  Effect.gen(function*() {
    const { cli } = yield* Renderer
    const mappedOptions = config.options
      ? config.options.map((opt) => ({
        name: opt.name,
        description: opt.description ?? "",
        value: opt.value
      }))
      : []
    return new SelectRenderable(cli, {
      ...config,
      options: mappedOptions
    })
  })
