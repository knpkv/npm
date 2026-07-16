import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

const RootBrowserScript = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.Struct({ "test:browser": Schema.String })
  })
)

describe("browser orchestration", () => {
  it.effect("keeps aggregate Playwright concurrency at one in CI", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packagePath = yield* path.fromFileUrl(new URL("../../../../package.json", import.meta.url))
      const workflowPath = yield* path.fromFileUrl(new URL("../../../../.github/workflows/check.yml", import.meta.url))
      const manifest = yield* fileSystem.readFileString(packagePath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RootBrowserScript))
      )
      const workflow = yield* fileSystem.readFileString(workflowPath)

      expect(manifest.scripts["test:browser"]).toBe(
        "pnpm --workspace-concurrency=1 --recursive --filter \"./packages/**/*\" --if-present run test:browser"
      )
      expect(workflow).toContain("run: pnpm test:browser")
    }).pipe(Effect.provide(NodeServices.layer)))
})
