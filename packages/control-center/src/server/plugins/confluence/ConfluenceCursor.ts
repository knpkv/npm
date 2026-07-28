/** Shared decoding for opaque Confluence pagination links. @internal */
import * as Effect from "effect/Effect"

import { PluginMalformedResponseFailure } from "../failures.js"

/** Decode one bounded provider cursor without assigning semantics to its contents. @internal */
export const decodeConfluenceNextCursor = (
  operation: string,
  diagnosticCode: string,
  next: string | undefined,
  maximumLength: number
): Effect.Effect<string | null, PluginMalformedResponseFailure> => {
  if (next === undefined) return Effect.succeed(null)
  const encoded = /(?:[?&])cursor=([^&#]+)/u.exec(next)?.[1]
  if (encoded === undefined) {
    return Effect.fail(
      new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: `${diagnosticCode}-missing`
      })
    )
  }
  return Effect.try({
    try: () => decodeURIComponent(encoded),
    catch: () =>
      new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: `${diagnosticCode}-invalid`
      })
  }).pipe(
    Effect.filterOrFail(
      (cursor) => cursor.length > 0 && cursor.length <= maximumLength,
      () =>
        new PluginMalformedResponseFailure({
          operation,
          diagnosticCode: `${diagnosticCode}-invalid`
        })
    )
  )
}
