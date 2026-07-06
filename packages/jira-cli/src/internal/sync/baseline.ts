/**
 * Sync Baseline helpers.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncValidationError, SyncWorkspaceError } from "../../JiraCliError.js"
import { SyncBaselineSchema } from "./schemas.js"
import type { SyncBaseline } from "./types.js"

export const parseSyncBaseline = (
  path: string,
  content: string
): Effect.Effect<SyncBaseline, SyncWorkspaceError | SyncValidationError> =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: (cause) => new SyncWorkspaceError({ message: "Failed to parse Sync Baseline JSON", path, cause })
    })
    const baseline: SyncBaseline = yield* Schema.decodeUnknownEffect(SyncBaselineSchema)(raw).pipe(
      Effect.mapError((cause) => new SyncValidationError({ message: "Invalid Sync Baseline", path, cause }))
    )
    return baseline
  })

export const serializeSyncBaseline = (baseline: SyncBaseline): string => `${JSON.stringify(baseline, null, 2)}\n`
