/**
 * Server half of the hosted stacks read model. `stacksHostLayer` composes the same discovery, SSO and
 * plan reader the standalone console runs; `makeStacksHostReads` turns them into tagged results. Paths and
 * tokens stay in this process: nothing here crosses the host's API except the results in `./host`.
 */
import { Effect, Layer, Path } from "effect"
import * as Config from "effect/Config"
import type { StackId, StackNotFound } from "./api.js"
import type { StackDetailResult, StackPlanResult, StacksOverviewResult } from "./host.js"
import { Catalog } from "./server/Catalog.js"
import { configuredPlanLayer, PlanReader } from "./server/PlanReader.js"
import { sourceLayer } from "./server/Sources.js"
import { ssoCredentialsLayer } from "./sso-credentials.js"

export { Catalog } from "./server/Catalog.js"
export { PlanReader } from "./server/PlanReader.js"

/** Where to discover: the same variables and defaults as the standalone console. */
export const stacksHostOptions = Effect.fn("AlchemyConsole.stacksHostOptions")(function*(home: string) {
  const path = yield* Path.Path
  return {
    root: yield* Config.String("ALCHEMY_CONSOLE_ROOT").pipe(Config.withDefault(path.join(home, "Work", "dev"))),
    awsConfigFile: yield* Config.String("AWS_CONFIG_FILE").pipe(Config.withDefault(path.join(home, ".aws", "config")))
  }
})

/** Catalog and plan reader for one host; the caller provides the platform and HTTP client. */
export const stacksHostLayer = (options: { readonly root: string; readonly awsConfigFile: string }) =>
  Layer.mergeAll(
    Catalog.layer.pipe(Layer.provide(sourceLayer(options)), Layer.provide(ssoCredentialsLayer())),
    configuredPlanLayer
  )

/** Reads as the hosting server serves them. A failed read is a result; only an unknown id fails. */
export interface StacksHostReads {
  readonly overview: Effect.Effect<StacksOverviewResult>
  readonly stack: (id: StackId) => Effect.Effect<StackDetailResult, StackNotFound>
  readonly plan: (id: StackId) => Effect.Effect<StackPlanResult, StackNotFound>
}

export const makeStacksHostReads: Effect.Effect<StacksHostReads, never, Catalog | PlanReader> = Effect.gen(
  function*() {
    const catalog = yield* Catalog
    const plans = yield* PlanReader
    return {
      overview: catalog.list.pipe(
        Effect.map((list): StacksOverviewResult => ({ _tag: "Ready", list })),
        Effect.catchTag(
          "CatalogReadError",
          ({ reason }) => Effect.succeed<StacksOverviewResult>({ _tag: "Failed", reason })
        )
      ),
      stack: (id) =>
        catalog.get(id).pipe(
          Effect.map((detail): StackDetailResult => ({ _tag: "Ready", detail })),
          Effect.catchTag("CatalogReadError", ({ reason }) =>
            Effect.succeed<StackDetailResult>({ _tag: "Failed", reason }))
        ),
      plan: (id) =>
        catalog.identify(id).pipe(
          Effect.flatMap(({ app, stage }) => plans.read(app, stage)),
          Effect.map((plan): StackPlanResult => ({ _tag: "Ready", plan }))
        )
    }
  }
)
