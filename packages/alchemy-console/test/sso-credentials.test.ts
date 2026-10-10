import type { fromSSO } from "@aws-sdk/credential-provider-sso"
import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import type { SsoProfile } from "../src/profiles.js"
import { SsoCredentials, ssoCredentialsLayer } from "../src/sso-credentials.js"

const sdk = { fromSSO: vi.fn<typeof fromSSO>() }
const profile: SsoProfile = {
  name: "fixture-profile",
  configFile: "fixture-config",
  account: "fixture-account",
  role: "FixtureReader",
  region: "eu-west-1",
  ssoRegion: "us-east-1",
  startUrl: "https://fixture.invalid/start",
  session: "fixture-session"
}

layer(ssoCredentialsLayer(sdk.fromSSO))("SSO credentials boundary", (it) => {
  it.effect("passes explicit SSO identity and config path without an ambient/static/process credential chain", () =>
    Effect.gen(function*() {
      sdk.fromSSO.mockReturnValue(async () => ({
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret",
        sessionToken: "fixture-token"
      }))
      const credentials = yield* SsoCredentials
      const result = yield* credentials.resolve(profile)
      expect(sdk.fromSSO).toHaveBeenLastCalledWith({
        profile: profile.name,
        configFilepath: profile.configFile,
        ssoAccountId: profile.account,
        ssoRoleName: profile.role,
        ssoRegion: profile.ssoRegion,
        ssoStartUrl: profile.startUrl,
        ssoSession: profile.session,
        clientConfig: { region: profile.ssoRegion },
        ignoreCache: true
      })
      expect(result.region).toBe(profile.region)
      expect(JSON.stringify(result)).not.toContain("fixture-secret")
      expect(JSON.stringify(result)).not.toContain("fixture-token")
      yield* credentials.resolve({ ...profile, session: null })
      expect(sdk.fromSSO.mock.calls.at(-1)?.[0]).not.toHaveProperty("ssoSession")
    }))

  it.effect("expired/missing sessions and invalid credentials fail without SDK messages or profile locators", () =>
    Effect.gen(function*() {
      const credentials = yield* SsoCredentials
      sdk.fromSSO.mockReturnValue(async () => Promise.reject("fixture-secret"))
      const error = yield* Effect.flip(credentials.resolve(profile))
      expect(error.reason).toBe("authentication")
      expect(JSON.stringify(error)).not.toContain("fixture-secret")
      expect(JSON.stringify(error)).not.toContain(profile.configFile)
      sdk.fromSSO.mockReturnValue(async () => ({
        accessKeyId: "fixture-access",
        secretAccessKey: "",
        sessionToken: "fixture-token"
      }))
      expect(yield* Effect.flip(credentials.resolve(profile))).toMatchObject({ reason: "authentication" })
    }))
})
