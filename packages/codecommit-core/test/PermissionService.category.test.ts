import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { PermissionService } from "../src/PermissionService/index.js"

/** The live service for a home directory, built in the test's scope. */
const permissionsIn = (home: string) =>
  Layer.build(PermissionService.Default).pipe(
    Effect.map((context) => Context.get(context, PermissionService)),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } }))
  )

describe("PermissionService.setCategory", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("grants every read at once and leaves writes prompting", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const permissions = yield* permissionsIn(home)

        yield* permissions.setCategory("read", "always_allow")

        expect(yield* permissions.check("getCallerIdentity")).toBe("always_allow")
        expect(yield* permissions.check("evaluatePullRequestApprovalRules")).toBe("always_allow")
        expect(yield* permissions.check("createPullRequest")).toBe("allow")
        const saved = JSON.parse(yield* fs.readFileString(path.join(home, ".codecommit", "permissions.json")))
        expect(saved.permissions.getPullRequests).toBe("always_allow")
        expect(saved.permissions.createPullRequest).toBeUndefined()
      }).pipe(Effect.scoped))

    it.effect("fails loudly and grants nothing when the file can't be saved", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        // HOME is a regular file, so ~/.codecommit can't be created under it.
        const home = path.join(root, "not-a-directory")
        yield* fs.writeFileString(home, "")
        const permissions = yield* permissionsIn(home)

        const error = yield* Effect.flip(permissions.setCategory("read", "always_allow"))

        expect(error._tag).toBe("ConfigError")
        expect(error.message).toContain(".codecommit/permissions.json")
        expect(yield* permissions.check("getPullRequests")).toBe("allow")
      }).pipe(Effect.scoped))
  })
})
