import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { discoverSsoProfiles } from "../src/profiles.js"

layer(NodeServices.layer)("SSO discovery", (it) => {
  it.effect("resolves modern sessions and legacy default; ignores process/static/service sections", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const config = path.join(root, "config")
      yield* fs.writeFileString(
        config,
        `[sso-session fixture-session]
sso_start_url = https://fixture.invalid/start
sso_region = us-east-1
[profile fixture-modern]
sso_session = fixture-session
sso_account_id = fixture-account
sso_role_name = FixtureReader
region = eu-west-1
[default]
sso_start_url = https://fixture.invalid/legacy
sso_region = us-east-2
sso_account_id = fixture-legacy-account
sso_role_name = FixtureLegacyReader
[profile fixture-static]
aws_access_key_id = fixture-secret
aws_secret_access_key = fixture-secret
[profile fixture-process]
credential_process = must-not-execute
[services fixture-service]
sso_region = us-east-1
`
      )
      const profiles = yield* discoverSsoProfiles(config)
      expect(profiles.map((p) => [p.name, p.region, p.ssoRegion, p.session])).toEqual([
        ["default", "us-east-2", "us-east-2", null],
        ["fixture-modern", "eu-west-1", "us-east-1", "fixture-session"]
      ])
      expect(JSON.stringify(profiles)).not.toContain("fixture-secret")
      expect(JSON.stringify(profiles)).not.toContain("must-not-execute")
    }).pipe(Effect.scoped))

  it.effect("missing config is empty; partial, missing-session and conflicting profiles fail without contents", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const config = path.join(root, "config")
      expect(yield* discoverSsoProfiles(config)).toEqual([])
      for (
        const text of [
          "[profile fixture-invalid]\nsso_region = fixture-secret",
          "[profile fixture-invalid]\nsso_session = fixture-secret",
          "[sso-session fixture-session]\nsso_region = us-east-1\n[profile fixture-invalid]\nsso_session = fixture-session\nsso_region = fixture-secret"
        ]
      ) {
        yield* fs.writeFileString(config, text)
        const error = yield* Effect.flip(discoverSsoProfiles(config))
        expect(error.reason).toBe("invalid-config")
        expect(JSON.stringify(error)).not.toContain("fixture-secret")
        expect(JSON.stringify(error)).not.toContain(config)
      }
    }).pipe(Effect.scoped))
})
