import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import { PermissionService } from "../src/PermissionService/index.js"

const TEST_HOME = "/tmp/codecommit-permissions-test"
const permissionPath = `${TEST_HOME}/.codecommit/permissions.json`

const permissionLayer = (content: string) => {
  const fileSystem = FileSystem.FileSystem.of({
    readFileString: (path) =>
      path === permissionPath
        ? Effect.succeed(content)
        : Effect.die(`Unexpected permissions path: ${path}`)
  })
  return PermissionService.Default.pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: TEST_HOME } })
      )
    )
  )
}

const readDefaultPermission = (content: string) =>
  Effect.gen(function*() {
    const permissions = yield* PermissionService
    return yield* permissions.check("getPullRequests")
  }).pipe(Effect.provide(permissionLayer(content)))

describe("PermissionService", () => {
  it.effect("falls back to prompt-by-default permissions for malformed JSON", () =>
    Effect.gen(function*() {
      expect(yield* readDefaultPermission("{ malformed")).toBe("allow")
    }))

  it.effect("falls back to prompt-by-default permissions for schema-invalid JSON", () =>
    Effect.gen(function*() {
      expect(
        yield* readDefaultPermission(JSON.stringify({
          permissions: { getPullRequests: "unexpected" }
        }))
      ).toBe("allow")
    }))
})
