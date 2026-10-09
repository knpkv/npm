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
  // One Playwright worker per machine: locally the root script runs suites one after another, and in CI
  // each matrix leg runs a single package's suite on its own runner (see scripts/check-browser-partition.test.mjs).
  it.effect("keeps Playwright concurrency at one per machine, locally and per CI runner", () =>
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
      expect(workflow).toContain("run: pnpm --filter \"@knpkv/${{ matrix.package }}\" run test:browser")
      expect(workflow).not.toContain("run: pnpm test:browser")
    }).pipe(Effect.provide(NodeServices.layer)))
})
