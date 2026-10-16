import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { StartProduct } from "../src/live.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { runConformance } from "../src/runner.js"
import { hasImplementedState, InvalidContract, type Manifest, RunnerFailure } from "../src/schema.js"

/** Existing products retain their package until a migration can preserve the previous live inventory. */
export const baseCaptureMode = Effect.fn("DesignConformance.baseCaptureMode")(
  function*(current: Manifest, base: ReadonlyArray<Manifest>, packageExists: boolean) {
    // A refs-only base never had a live inventory, so its first implementation starts as a new product.
    const previous = base.find((manifest) => manifest.product === current.product && hasImplementedState(manifest))
    if (previous !== undefined && previous.live.package !== current.live.package) {
      return yield* new RunnerFailure({
        detail:
          `Existing product ${current.product} changed live.package from ${previous.live.package} to ${current.live.package}; package migrations must preserve the previous live inventory`
      })
    }
    if (packageExists) return "capture"
    if (previous !== undefined) {
      return yield* new RunnerFailure({
        detail:
          `Existing product ${current.product} has no merge-base package ${current.live.package}; cannot discard its previous live inventory`
      })
    }
    return "new"
  }
)

const Adapter = Schema.Struct({ start: Schema.declare((value): value is StartProduct => Predicate.isFunction(value)) })

/** The adapter is repository code, not a provider or a remotely loaded script. */
export const loadProduct = Effect.fn("DesignConformance.loadProduct")(function*(repository: string, file: string) {
  const path = yield* Path.Path
  const url = yield* path.toFileUrl(path.join(repository, file))
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(url.href),
    catch: (cause) => new InvalidContract({ file, cause })
  })
  return yield* Schema.decodeUnknownEffect(Adapter)(module).pipe(
    Effect.mapError((cause) => new InvalidContract({ file, cause }))
  )
})

/** PR refs and adapter drive the base app, even before references or gate code exist on the base. */
export const captureBaseProduct = Effect.fn("DesignConformance.captureBaseProduct")(function*(
  repository: string,
  checkout: string,
  product: string,
  output: string
) {
  const path = yield* Path.Path
  const refs = yield* loadReferences(path.join(repository, "design-refs", product))
  const adapter = yield* loadProduct(repository, refs.manifest.live.adapter)
  const live = yield* adapter.start(refs.fixture, checkout)
  yield* runConformance(refs, { output, captureOnly: true }).pipe(Effect.provideService(LiveProduct, live))
})

/** Only declared reference inputs qualify. Live adapters and unlisted inventory/code files never do. */
export const isReferenceOnlyChange = (files: ReadonlyArray<string>, manifests: ReadonlyArray<Manifest>): boolean => {
  for (const manifest of manifests) {
    if (
      manifests.some((other) =>
        other.product === manifest.product &&
        (other.live.adapter !== manifest.live.adapter || other.live.package !== manifest.live.package)
      )
    ) return false
  }
  const adapters = new Set(manifests.map((manifest) => manifest.live.adapter))
  const inputs = new Set(manifests.flatMap((manifest) => {
    const root = `design-refs/${manifest.product}/`
    return ["manifest.json", "waivers.json", ...Object.keys(manifest.files)].map((file) => `${root}${file}`)
  }))
  return files.length > 0 && files.every((file) => inputs.has(file) && !adapters.has(file))
}
