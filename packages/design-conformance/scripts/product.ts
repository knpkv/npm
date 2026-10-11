import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { StartProduct } from "../src/live.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { runConformance } from "../src/runner.js"
import { InvalidContract } from "../src/schema.js"

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

/** A refs-only PR can alter capture inputs without changing the application's live UI. */
export const isReferenceOnlyChange = (files: ReadonlyArray<string>): boolean =>
  files.length > 0 && files.every((file) => file.startsWith("design-refs/"))
