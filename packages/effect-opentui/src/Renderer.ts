/**
 * Renderer service wrapping OpenTUI CliRenderer.
 */
import { type CliRenderer, createCliRenderer, type RootRenderable } from "@opentui/core"
import { Context, Effect, Layer } from "effect"
import { RendererError } from "./RendererError.ts"

/**
 * Configuration options for the Renderer service.
 *
 * @category models
 */
export interface RendererConfig {
  readonly exitOnCtrlC?: boolean
  readonly useAlternateScreen?: boolean
  readonly targetFps?: number
}

/**
 * Renderer service interface.
 *
 * @category models
 */
export interface RendererService {
  readonly cli: CliRenderer
  readonly root: RootRenderable
  readonly start: Effect.Effect<void, RendererError>
  readonly stop: Effect.Effect<void, RendererError>
  readonly requestRender: Effect.Effect<void>
}

/**
 * Renderer service tag for Effect dependency injection.
 *
 * @category services
 * @example
 * import { Effect } from "effect"
 * import { Renderer, RendererLive } from "@knpkv/effect-opentui"
 *
 * const program = Effect.gen(function*() {
 *   const renderer = yield* Renderer
 *   yield* renderer.start
 *   // ... render UI
 *   yield* renderer.stop
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(RendererLive)))
 */
export class Renderer extends Context.Tag("@knpkv/effect-opentui/Renderer")<
  Renderer,
  RendererService
>() {}

/**
 * Default renderer configuration.
 *
 * @category config
 */
export const defaultConfig: RendererConfig = {
  exitOnCtrlC: false,
  useAlternateScreen: true,
  targetFps: 30
}

/**
 * Creates a Renderer layer with the specified configuration.
 *
 * @category layers
 */
export const makeRendererLayer = (config: RendererConfig = defaultConfig): Layer.Layer<Renderer, RendererError> =>
  Layer.scoped(
    Renderer,
    Effect.gen(function*() {
      const cli = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              exitOnCtrlC: config.exitOnCtrlC ?? false,
              useAlternateScreen: config.useAlternateScreen ?? true,
              targetFps: config.targetFps ?? 30
            }),
          catch: (error) => new RendererError({ reason: "Failed to create renderer", cause: error })
        }),
        (renderer) => Effect.sync(() => renderer.destroy())
      )

      return {
        cli,
        root: cli.root,
        start: Effect.try({
          try: () => cli.start(),
          catch: (error) => new RendererError({ reason: "Failed to start renderer", cause: error })
        }),
        stop: Effect.try({
          try: () => cli.stop(),
          catch: (error) => new RendererError({ reason: "Failed to stop renderer", cause: error })
        }),
        requestRender: Effect.sync(() => cli.requestRender())
      }
    })
  )

/**
 * Live Renderer layer with default configuration.
 *
 * @category layers
 */
export const RendererLive: Layer.Layer<Renderer, RendererError> = makeRendererLayer()
