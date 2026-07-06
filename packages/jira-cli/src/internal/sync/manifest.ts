/**
 * Sync Manifest helpers.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncValidationError, SyncWorkspaceError } from "../../JiraCliError.js"
import { SyncManifestSchema } from "./schemas.js"
import type { SyncManifest } from "./types.js"

export const makeEmptyManifest = (siteUrl: string): SyncManifest => ({
  version: 1,
  siteUrl,
  issues: []
})

export const parseSyncManifest = (
  path: string,
  content: string
): Effect.Effect<SyncManifest, SyncWorkspaceError | SyncValidationError> =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: (cause) => new SyncWorkspaceError({ message: "Failed to parse Sync Manifest JSON", path, cause })
    })
    return yield* Schema.decodeUnknownEffect(SyncManifestSchema)(raw).pipe(
      Effect.mapError((cause) => new SyncValidationError({ message: "Invalid Sync Manifest", path, cause }))
    )
  })

export const serializeSyncManifest = (manifest: SyncManifest): string => `${JSON.stringify(manifest, null, 2)}\n`
