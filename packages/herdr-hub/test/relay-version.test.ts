import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { readRelayVersion } from "../src/internal/relay-version.js"

it.layer(NodeServices.layer)((it) => {
  it.effect("reads the released package version used by CLI and MCP startup", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const manifestPath = yield* paths.fromFileUrl(new URL("../package.json", import.meta.url))
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))
      )(yield* fs.readFileString(manifestPath))
      expect(yield* readRelayVersion()).toBe(manifest.version)
    }))
})
