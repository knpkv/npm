/**
 * Keyboard input handling as Effect streams.
 */
import type { KeyEvent } from "@opentui/core"
import { Effect, Option, Stream } from "effect"
import { Renderer } from "../Renderer.ts"

export type { KeyEvent }

/**
 * Stream of keyboard events from the renderer.
 *
 * @category streams
 * @example
 * import { Effect, Stream } from "effect"
 * import { Renderer, RendererLive } from "@knpkv/effect-opentui"
 * import { keyEvents } from "@knpkv/effect-opentui/input"
 *
 * const program = Effect.gen(function*() {
 *   yield* keyEvents.pipe(
 *     Stream.take(10),
 *     Stream.tap((key) => Effect.log(`Key pressed: ${key.name}`)),
 *     Stream.runDrain
 *   )
 * })
 */
export const keyEvents: Stream.Stream<KeyEvent, never, Renderer> = Stream.asyncScoped<KeyEvent, never, Renderer>((
  emit
) =>
  Effect.gen(function*() {
    const { cli } = yield* Renderer

    const handler = (key: KeyEvent) => {
      emit.single(key)
    }

    cli.keyInput.on("keypress", handler)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        cli.keyInput.off("keypress", handler)
      })
    )
  })
)

/**
 * Filter key events by key name.
 *
 * @category filters
 */
export const onKey = (name: string): Stream.Stream<KeyEvent, never, Renderer> =>
  keyEvents.pipe(Stream.filter((k) => k.name === name))

/**
 * Filter key events by key combo (name + modifiers).
 *
 * @category filters
 */
export const onKeyCombo = (opts: {
  readonly name: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}): Stream.Stream<KeyEvent, never, Renderer> =>
  keyEvents.pipe(
    Stream.filter((k) =>
      k.name === opts.name &&
      (opts.ctrl === undefined || k.ctrl === opts.ctrl) &&
      (opts.shift === undefined || k.shift === opts.shift) &&
      (opts.meta === undefined || k.meta === opts.meta)
    )
  )

/**
 * Stream that emits when navigation keys are pressed (hjkl or arrows).
 *
 * @category filters
 */
export const navigationKeys: Stream.Stream<
  { direction: "up" | "down" | "left" | "right"; key: KeyEvent },
  never,
  Renderer
> = keyEvents.pipe(
  Stream.filterMap((k) => {
    if (k.name === "up" || k.name === "k") {
      return Option.some({ direction: "up" as const, key: k })
    }
    if (k.name === "down" || k.name === "j") {
      return Option.some({ direction: "down" as const, key: k })
    }
    if (k.name === "left" || k.name === "h") {
      return Option.some({ direction: "left" as const, key: k })
    }
    if (k.name === "right" || k.name === "l") {
      return Option.some({ direction: "right" as const, key: k })
    }
    return Option.none()
  })
)
