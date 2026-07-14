import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

import type { PluginConnectionV1 } from "../../src/server/plugins/PluginConnection.js"

type ForbiddenExecutionMember = Extract<
  keyof PluginConnectionV1,
  "preflight" | "executeAuthorizedAction" | "requestCancellation" | "reconcile"
>

const publicConnectionHasNoExecutionMember: ForbiddenExecutionMember extends never ? true : false = true

describe("plugin execution boundary", () => {
  it("keeps preflight, execution, cancellation, and reconciliation off the public connection", () => {
    assert.isTrue(publicConnectionHasNoExecutionMember)
  })

  it.effect("keeps the internal executor out of public barrels and packed subpath exports", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
      const pluginBarrel = yield* fileSystem.readFileString(path.join(packageRoot, "src/server/plugins/index.ts"))
      const serverBarrel = yield* fileSystem.readFileString(path.join(packageRoot, "src/server/index.ts"))
      const manifest = yield* fileSystem.readFileString(path.join(packageRoot, "package.json"))

      assert.notInclude(pluginBarrel, "./internal/")
      assert.notInclude(pluginBarrel, "AuthorizedPluginExecutor")
      assert.notInclude(serverBarrel, "AuthorizedPluginExecutor")
      assert.notInclude(manifest, "./server/plugins/internal")
      assert.notInclude(manifest, "\"./server/*\"")
    }).pipe(Effect.provide(NodeServices.layer)))
})
