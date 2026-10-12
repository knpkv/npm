import { Unavailable } from "@knpkv/herdr-connect"
import { Effect, FileSystem, Path, Schema } from "effect"

/** Source and compiled internal modules sit two directories below the package manifest. */
export const readRelayVersion = Effect.fn("Relay.readVersion")(function*() {
  const paths = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const path = yield* paths.fromFileUrl(new URL("../../package.json", import.meta.url)).pipe(
    Effect.mapError(() => new Unavailable({ operation: "relay.version" }))
  )
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError(() => new Unavailable({ operation: "relay.version" }))
  )
  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))
  )(text).pipe(Effect.mapError(() => new Unavailable({ operation: "relay.version" })))
  return manifest.version
})
