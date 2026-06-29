import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { SystemError } from "effect/PlatformError"
import {
  type AtlassianToolDefinition,
  HomeDirectoryLive,
  inspectAllToolProfiles,
  migrateLegacyProfiles,
  MissingOAuthConfigError,
  missingScopes,
  type OAuthToken,
  ProfileNotFoundError,
  refreshActiveProfiles,
  saveProfileToken,
  useProfileForAllTools
} from "../src/config/index.js"

const TEST_HOME = "/tmp/atlassian-common-manager-test"
const tools: ReadonlyArray<AtlassianToolDefinition> = [
  { toolName: "tool-a", label: "Tool A", loginHint: "tool-a login", requiredScopes: ["read:me", "offline_access"] },
  { toolName: "tool-b", label: "Tool B", loginHint: "tool-b login", requiredScopes: ["read:me", "write:jira-work"] }
]
const sharedStoreTools: ReadonlyArray<AtlassianToolDefinition> = [
  tools[0]!,
  {
    toolName: "tool-c",
    authStoreName: "tool-a",
    label: "Tool C",
    loginHint: "tool-c login",
    requiredScopes: ["read:me"]
  }
]

const fsError = (method: string) =>
  Effect.fail(new SystemError({ _tag: "NotFound", module: "FileSystem", method, description: "mock not found" }))

const makeToken = (n: number, scope = "read:me offline_access", expiresAt = Date.now() + 60_000): OAuthToken => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_at: expiresAt,
  scope,
  cloud_id: `cloud-${n}`,
  site_url: `https://site-${n}.atlassian.net`,
  user: { account_id: `account-${n}`, name: `User ${n}`, email: `user-${n}@example.com` }
})

const makeMockFS = () => {
  const store: Record<string, string> = {}
  const partial: Partial<FileSystem.FileSystem> = {
    exists: (path) => Effect.succeed(path in store),
    readFileString: (path) => path in store ? Effect.succeed(store[path]!) : fsError("readFileString"),
    writeFileString: (path: string, content: string) => {
      store[path] = content
      return Effect.void
    },
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    remove: (path: string) => {
      delete store[path]
      return Effect.void
    }
  }
  return {
    store,
    layer: Layer.succeed(FileSystem.FileSystem, FileSystem.FileSystem.of(partial as FileSystem.FileSystem))
  }
}

const ConfigProviderLive = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: TEST_HOME } }))

const run = async <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>) => {
  const mock = makeMockFS()
  const layer = Layer.mergeAll(mock.layer, Path.layer, HomeDirectoryLive, ConfigProviderLive)
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, store: mock.store }
}

describe("ProfileManager", () => {
  it("reports missing scopes from a token", () => {
    expect(missingScopes(makeToken(1), ["read:me", "write:jira-work"])).toEqual(["write:jira-work"])
  })

  it("inspects active profile usage and scope status per tool", async () => {
    const { result } = await run(
      Effect.gen(function*() {
        yield* saveProfileToken("tool-a", makeToken(1))
        yield* saveProfileToken("tool-b", makeToken(2))
        return yield* inspectAllToolProfiles(tools)
      })
    )

    expect(result.map((status) => status.activeProfile?.id)).toEqual(["account-1@cloud-1", "account-2@cloud-2"])
    expect(result[0]!.missingScopes).toEqual([])
    expect(result[1]!.missingScopes).toEqual(["write:jira-work"])
  })

  it("switches matching profiles without copying tokens between auth stores", async () => {
    const { result, store } = await run(
      Effect.gen(function*() {
        yield* saveProfileToken("tool-a", makeToken(1))
        yield* saveProfileToken("tool-b", makeToken(2, "read:me write:jira-work"))
        return yield* useProfileForAllTools("https://site-2.atlassian.net", tools)
      })
    )

    expect(result.map((status) => status.activeProfile?.id)).toEqual(["account-1@cloud-1", "account-2@cloud-2"])
    expect(JSON.parse(store[`${TEST_HOME}/.config/atlassian/tool-a/auth.json`]!)["access_token"]).toBe("access-1")
  })

  it("reports multiple tools that share one auth store", async () => {
    const { result } = await run(
      Effect.gen(function*() {
        yield* saveProfileToken("tool-a", makeToken(1))
        return yield* inspectAllToolProfiles(sharedStoreTools)
      })
    )

    expect(result.map((status) => status.authStoreName)).toEqual(["tool-a", "tool-a"])
    expect(result.map((status) => status.activeProfile?.id)).toEqual(["account-1@cloud-1", "account-1@cloud-1"])
  })

  it("migrates XDG legacy auth.json tokens into profile stores", async () => {
    const token = makeToken(3)
    const { result, store } = await run(
      Effect.gen(function*() {
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            fs.writeFileString(`${TEST_HOME}/.config/atlassian/tool-a/auth.json`, JSON.stringify(token, null, 2))
          )
        )
        return yield* migrateLegacyProfiles(tools)
      })
    )

    expect(result[0]!.activeProfile?.id).toBe("account-3@cloud-3")
    expect(JSON.parse(store[`${TEST_HOME}/.config/atlassian/tool-a/profiles.json`]!)["profiles"]).toHaveLength(1)
  })

  it("migrates tool-specific legacy auth.json tokens into profile stores", async () => {
    const token = makeToken(4)
    const legacyTools: ReadonlyArray<AtlassianToolDefinition> = [
      {
        toolName: "legacy-tool",
        legacyAuthPath: [".legacy-tool", "auth.json"],
        label: "Legacy Tool",
        loginHint: "legacy login",
        requiredScopes: ["read:me"]
      }
    ]
    const { result, store } = await run(
      Effect.gen(function*() {
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            fs.writeFileString(`${TEST_HOME}/.legacy-tool/auth.json`, JSON.stringify(token, null, 2))
          )
        )
        return yield* migrateLegacyProfiles(legacyTools)
      })
    )

    expect(result[0]!.activeProfile?.id).toBe("account-4@cloud-4")
    expect(JSON.parse(store[`${TEST_HOME}/.config/atlassian/legacy-tool/profiles.json`]!)["profiles"]).toHaveLength(1)
  })

  it("fails when selecting a missing profile", async () => {
    await expect(
      run(
        Effect.gen(function*() {
          yield* saveProfileToken("tool-a", makeToken(1))
          return yield* useProfileForAllTools("missing", tools)
        })
      )
    ).rejects.toBeInstanceOf(ProfileNotFoundError)
  })

  it("fails expired-token refresh when OAuth config is missing", async () => {
    await expect(
      run(
        Effect.gen(function*() {
          yield* saveProfileToken("tool-a", makeToken(1, "read:me offline_access", Date.now() - 1_000))
          return yield* refreshActiveProfiles([tools[0]!])
        })
      )
    ).rejects.toBeInstanceOf(MissingOAuthConfigError)
  })
})
