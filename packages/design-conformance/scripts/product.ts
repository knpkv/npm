import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { StartProduct } from "../src/live.js"
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
