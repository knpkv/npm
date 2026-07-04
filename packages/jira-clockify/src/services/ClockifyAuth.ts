/**
 * File-based Clockify API key storage with schema-validated reads.
 *
 * **Mental model**
 *
 * - **Credential file**: Reads/writes `~/.jcf/clockify.json` containing API key, workspace ID,
 *   user ID, and base URL. The API key is wrapped in `Redacted` on read.
 * - **Schema-gated**: JSON is parsed then validated via `Schema.decodeUnknownEffect(StoredAuth)` —
 *   corrupt data yields {@link ClockifyAuthMissingError} instead of a crash.
 * - **Config-based home dir**: Uses Effect `Config.string("HOME")` for testable env access.
 *
 * @module
 */
import type { ClockifyApiConfigShape } from "@knpkv/clockify-api-client"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { HomeDirectory } from "./HomeDirectory.js"

export class ClockifyAuthMissingError extends Data.TaggedError("ClockifyAuthMissingError")<{
  readonly message: string
}> {}

const StoredAuth = Schema.Struct({
  apiKey: Schema.String,
  workspaceId: Schema.String,
  userId: Schema.String,
  baseUrl: Schema.optional(Schema.String)
})
interface StoredAuth extends Schema.Schema.Type<typeof StoredAuth> {}

export interface ClockifyAuthShape {
  readonly getConfig: Effect.Effect<ClockifyApiConfigShape, ClockifyAuthMissingError>
  readonly save: (auth: StoredAuth) => Effect.Effect<void>
  readonly isConfigured: Effect.Effect<boolean>
}

export class ClockifyAuth extends Context.Service<ClockifyAuth, ClockifyAuthShape>()("jcf/ClockifyAuth") {}

const AUTH_DIR = ".jcf"
const AUTH_FILE = "clockify.json"
const DEFAULT_BASE_URL = "https://api.clockify.me/api"

export const layer = Layer.effect(
  ClockifyAuth,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const dir = path.join(home, AUTH_DIR)
    const filePath = path.join(dir, AUTH_FILE)

    const ensureDir = Effect.gen(function*() {
      const exists = yield* fs.exists(dir)
      if (!exists) yield* fs.makeDirectory(dir, { recursive: true })
    })

    const decodeStoredAuth = Schema.decodeUnknownEffect(StoredAuth)

    return {
      getConfig: Effect.gen(function*() {
        const exists = yield* fs.exists(filePath)
        if (!exists) {
          return yield* Effect.fail(
            new ClockifyAuthMissingError({
              message: "Clockify not configured. Run: jcf auth clockify setup"
            })
          )
        }
        const content = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(() => new ClockifyAuthMissingError({ message: "Failed to read Clockify auth file" }))
        )
        const json = yield* Effect.try({
          try: () => JSON.parse(content) as unknown,
          catch: () => new ClockifyAuthMissingError({ message: "Invalid JSON in Clockify auth file" })
        })
        const stored = yield* decodeStoredAuth(json).pipe(
          Effect.mapError(() => new ClockifyAuthMissingError({ message: "Invalid Clockify auth file schema" }))
        )
        return {
          apiKey: Redacted.make(stored.apiKey),
          workspaceId: stored.workspaceId,
          userId: stored.userId,
          baseUrl: stored.baseUrl ?? DEFAULT_BASE_URL
        }
      }).pipe(
        Effect.catch((error) =>
          Predicate.isTagged(error, "ClockifyAuthMissingError")
            ? Effect.fail(error)
            : Effect.fail(new ClockifyAuthMissingError({ message: "Failed to read Clockify auth" }))
        )
      ),

      save: (auth) =>
        Effect.gen(function*() {
          yield* ensureDir
          yield* fs.writeFileString(filePath, JSON.stringify(auth, null, 2))
          yield* fs.chmod(filePath, 0o600).pipe(Effect.catch(() => Effect.void))
        }).pipe(Effect.catch(() => Effect.void)),

      isConfigured: fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)))
    }
  })
)
