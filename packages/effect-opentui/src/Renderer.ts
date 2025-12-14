/**
 * Renderer service for OpenTUI React.
 */
import * as OpenTuiCore from "@opentui/core"
import * as OpenTuiReact from "@opentui/react"
import { Context, Effect, Layer } from "effect"
import type { ReactNode } from "react"

import { RendererError } from "./RendererError.ts"

type CliRenderer = OpenTuiCore.CliRenderer
type Root = OpenTuiReact.Root

/**
 * Renderer service for terminal UI.
 *
 * @category services
 */
export class Renderer extends Context.Tag("@knpkv/effect-opentui/Renderer")<
  Renderer,
  {
    readonly cli: CliRenderer
    readonly root: Root
    readonly render: (node: ReactNode) => Effect.Effect<void>
    readonly start: Effect.Effect<void>
    readonly stop: Effect.Effect<void>
  }
>() {}

/**
 * Configuration for the Renderer.
 *
 * @category config
 */
export interface RendererConfig {
  readonly targetFps?: number
  readonly exitOnCtrlC?: boolean
  readonly useKittyKeyboard?: object
}

/**
 * Creates a Renderer layer with the given config.
 *
 * @category layers
 */
export const makeRendererLayer = (config: RendererConfig = {}): Layer.Layer<Renderer, RendererError> =>
  Layer.scoped(
    Renderer,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const cli = await OpenTuiCore.createCliRenderer({
            targetFps: config.targetFps !== undefined ? config.targetFps : 60,
            exitOnCtrlC: config.exitOnCtrlC !== undefined ? config.exitOnCtrlC : false,
            useKittyKeyboard: config.useKittyKeyboard !== undefined ? config.useKittyKeyboard : {}
          })
          const root = OpenTuiReact.createRoot(cli)

          return {
            cli,
            root,
            render: (node: ReactNode) =>
              Effect.sync(() => {
                root.render(node)
              }),
            start: Effect.sync(() => {
              cli.start()
            }),
            stop: Effect.sync(() => {
              cli.stop()
            })
          }
        },
        catch: (error) => new RendererError({ reason: `Failed to create renderer: ${String(error)}` })
      }),
      (service) =>
        Effect.sync(() => {
          service.root.unmount()
          service.cli.destroy()
        })
    )
  )

/**
 * Default renderer layer.
 *
 * @category layers
 */
export const RendererLive: Layer.Layer<Renderer, RendererError> = makeRendererLayer()
