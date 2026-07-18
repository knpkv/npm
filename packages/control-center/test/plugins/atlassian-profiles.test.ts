import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { HomeDirectoryTag } from "@knpkv/atlassian-common/profile-storage"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import {
  discoverAtlassianProfiles,
  loadAtlassianProfile
} from "../../src/server/plugins/atlassian/AtlassianProfiles.js"

const profile = (accessToken: string) => ({
  id: "account-1@cloud-1",
  name: "Avery Bell @ team.atlassian.net",
  token: {
    access_token: accessToken,
    refresh_token: "refresh-secret",
    expires_at: 4_102_444_800_000,
    scope: "read:me offline_access",
    cloud_id: "cloud-1",
    site_url: "https://team.atlassian.net/",
    user: { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
  },
  created_at: "2026-07-18T10:00:00.000Z",
  updated_at: "2026-07-18T10:00:00.000Z"
})

describe("AtlassianProfiles", () => {
  it.effect("deduplicates shared profiles without exposing credential material", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-profiles-" })
      for (const storeName of ["jira-cli", "confluence-to-markdown"]) {
        const storePath = path.join(home, ".config", "atlassian", storeName)
        yield* fileSystem.makeDirectory(storePath, { recursive: true })
        yield* fileSystem.writeFileString(
          path.join(storePath, "profiles.json"),
          JSON.stringify({ activeProfileId: "account-1@cloud-1", profiles: [profile(`${storeName}-secret`)] })
        )
      }

      const homeDirectory = { get: () => Effect.succeed(home) }
      const configProvider = ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: path.join(home, ".config") })
      const discovered = yield* discoverAtlassianProfiles().pipe(
        Effect.provideService(HomeDirectoryTag, homeDirectory),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(discovered, [{
        profileId: "account-1@cloud-1",
        name: "Avery Bell @ team.atlassian.net",
        siteUrl: "https://team.atlassian.net/",
        cloudId: "cloud-1",
        accountName: "Avery Bell",
        accountEmail: "avery@example.com",
        status: "valid",
        providers: ["jira", "confluence"]
      }])
      assert.notInclude(JSON.stringify(discovered), "secret")

      const loaded = yield* loadAtlassianProfile("confluence", "account-1@cloud-1").pipe(
        Effect.provideService(HomeDirectoryTag, homeDirectory),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(loaded?.token.access_token, "confluence-to-markdown-secret")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
