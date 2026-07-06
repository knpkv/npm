import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { SystemError } from "effect/PlatformError"
import {
  deleteProfileBySelector,
  HomeDirectoryLive,
  loadActiveProfileToken,
  loadProfiles,
  type OAuthToken,
  saveProfileToken,
  setActiveProfileBySelector
} from "../src/config/index.js"

const TEST_HOME = "/tmp/atlassian-common-profile-test"
const TOOL_NAME = "test-tool"
const basePath = `${TEST_HOME}/.config/atlassian/${TOOL_NAME}`
const authPath = `${basePath}/auth.json`
const profilesPath = `${basePath}/profiles.json`

const fsError = (method: string) =>
  Effect.fail(
    new SystemError({ _tag: "NotFound", module: "FileSystem", method, description: "mock not found" })
  )

const makeToken = (n: number): OAuthToken => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_at: Date.now() + 60_000,
  scope: "read:me offline_access",
  cloud_id: `cloud-${n}`,
  site_url: `https://site-${n}.atlassian.net`,
  user: {
    account_id: `account-${n}`,
    name: `User ${n}`,
    email: `user-${n}@example.com`
  }
})

const makeMockFS = (files: Record<string, string> = {}) => {
  const store = { ...files }
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
    layer: Layer.succeed(FileSystem.FileSystem, FileSystem.FileSystem.of(partial))
  }
}

const ConfigProviderLive = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { HOME: TEST_HOME } })
)

const run = <A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
  files?: Record<string, string>
) => {
  const mock = makeMockFS(files)
  const layer = Layer.mergeAll(mock.layer, Path.layer, HomeDirectoryLive, ConfigProviderLive)
  return Effect.runPromise(effect.pipe(Effect.provide(layer))).then((result) => ({ result, store: mock.store }))
}

describe("AuthProfiles", () => {
  it("upserts profiles and mirrors the active profile to auth.json", async () => {
    const first = makeToken(1)
    const second = makeToken(2)

    const { result: profiles, store } = await run(
      Effect.gen(function*() {
        yield* saveProfileToken(TOOL_NAME, first)
        yield* saveProfileToken(TOOL_NAME, second)
        return yield* loadProfiles(TOOL_NAME)
      })
    )

    expect(profiles.profiles.map((profile) => profile.id)).toEqual(["account-2@cloud-2", "account-1@cloud-1"])
    expect(profiles.activeProfileId).toBe("account-2@cloud-2")
    expect(JSON.parse(store[authPath]!)["access_token"]).toBe("access-2")
    expect(JSON.parse(store[profilesPath]!)["profiles"]).toHaveLength(2)
  })

  it("switches and removes profiles by flexible selector", async () => {
    const first = makeToken(1)
    const second = makeToken(2)

    const { result, store } = await run(
      Effect.gen(function*() {
        yield* saveProfileToken(TOOL_NAME, first)
        yield* saveProfileToken(TOOL_NAME, second)
        const selected = yield* setActiveProfileBySelector(TOOL_NAME, first.site_url)
        const activeAfterSwitch = yield* loadActiveProfileToken(TOOL_NAME)
        const removed = yield* deleteProfileBySelector(TOOL_NAME, first.user!.account_id)
        const activeAfterRemove = yield* loadActiveProfileToken(TOOL_NAME)
        return { selected, activeAfterSwitch, removed, activeAfterRemove }
      })
    )

    expect(result.selected?.id).toBe("account-1@cloud-1")
    expect(result.activeAfterSwitch?.access_token).toBe("access-1")
    expect(result.removed?.id).toBe("account-1@cloud-1")
    expect(result.activeAfterRemove?.access_token).toBe("access-2")
    expect(JSON.parse(store[authPath]!)["access_token"]).toBe("access-2")
  })

  it("loads a legacy auth.json token as a single active profile", async () => {
    const token = makeToken(1)

    const { result } = await run(
      loadProfiles(TOOL_NAME),
      { [authPath]: JSON.stringify(token, null, 2) }
    )

    expect(result.activeProfileId).toBe("account-1@cloud-1")
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]?.token.access_token).toBe("access-1")
  })
})
