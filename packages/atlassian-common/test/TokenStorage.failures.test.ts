import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
import * as Path from "effect/Path"
import { PlatformError, SystemError } from "effect/PlatformError"
import {
  type AtlassianToolDefinition,
  deleteToken,
  HomeDirectoryLive,
  loadToken,
  migrateLegacyProfiles
} from "../src/config/index.js"

const TEST_HOME = "/tmp/atlassian-common-failures-test"

const failure = (method: string, tag: "NotFound" | "PermissionDenied") =>
  Effect.fail(new PlatformError(new SystemError({ _tag: tag, module: "FileSystem", method, description: tag })))

const layerWith = (fs: Partial<FileSystem.FileSystem>) =>
  Layer.mergeAll(
    FileSystem.layerNoop(fs),
    Path.layer,
    HomeDirectoryLive,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: TEST_HOME } }))
  )

describe("token storage failures", () => {
  it.layer(layerWith({ remove: () => failure("remove", "NotFound") }))("a token that is already gone", (it) => {
    it.effect("deletes without failing", () => deleteToken("tool-a"))
  })

  // A delete that fails for any other reason leaves the token on disk, so logout must not report success.
  it.layer(layerWith({ remove: () => failure("remove", "PermissionDenied") }))(
    "a token the system refuses to remove",
    (it) => {
      it.effect("fails the delete with a FileSystemError", () =>
        Effect.gen(function*() {
          const error = yield* deleteToken("tool-a").pipe(Effect.flip)
          expect(error._tag).toBe("FileSystemError")
          expect(error).toMatchObject({ operation: "delete" })
        }))
    }
  )

  // An unreadable auth directory used to read as "not signed in".
  it.layer(layerWith({ exists: () => failure("exists", "PermissionDenied") }))(
    "a token whose existence cannot be checked",
    (it) => {
      it.effect("fails instead of reading as signed out", () =>
        Effect.gen(function*() {
          const error = yield* loadToken("tool-a").pipe(Effect.flip)
          expect(error._tag).toBe("FileSystemError")
          expect(error).toMatchObject({ operation: "check" })
        }))
    }
  )

  const legacyPath = `${TEST_HOME}/.legacy-tool/auth.json`
  it.layer(layerWith({
    exists: (path) => Effect.succeed(path === legacyPath),
    readFileString: (path) => path === legacyPath ? Effect.succeed("not json") : failure("readFileString", "NotFound")
  }))("a legacy auth file that is not JSON", (it) => {
    it.effect("is skipped with a warning naming it", () =>
      Effect.gen(function*() {
        const tool: AtlassianToolDefinition = {
          toolName: "legacy-tool",
          label: "Legacy",
          loginHint: "legacy login",
          requiredScopes: ["read:me"],
          legacyAuthPath: [".legacy-tool", "auth.json"]
        }
        const messages: Array<unknown> = []
        const logger = Logger.make<unknown, void>((entry) => {
          messages.push(entry.message)
        })
        const statuses = yield* migrateLegacyProfiles([tool]).pipe(Effect.withLogger(logger))
        expect(statuses.map((status) => status.activeProfile)).toEqual([null])
        expect(messages.map(String).join("\n")).toContain(`Skipping the legacy auth file at ${legacyPath}`)
      }))
  })
})
