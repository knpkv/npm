import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { afterEach, vi } from "vitest"

import { AwsClientConfig, Default } from "../src/AwsClientConfig.js"
import { makeProfileCredentialProvider } from "../src/AwsProfileCredentials.js"

const credentials = (accessKeyId: string) => ({
  accessKeyId,
  secretAccessKey: "secret"
})

describe("AWS profile credential resolution", () => {
  it("names the default profile explicitly to both providers", async () => {
    const calls: Array<readonly [provider: "sso" | "fallback", options: { readonly profile?: string } | undefined]> = []
    const provider = makeProfileCredentialProvider({
      sso: (options) => {
        calls.push(["sso", options])
        return async () => credentials("sso")
      },
      fallback: (options) => {
        calls.push(["fallback", options])
        return async () => credentials("standard-chain")
      }
    })

    await provider("default")

    assert.deepStrictEqual(calls, [
      ["sso", { profile: "default" }],
      ["fallback", { profile: "default" }]
    ])
  })

  it("prefers SSO when a profile is configured in both AWS config files", async () => {
    let fallbackCalls = 0
    const provider = makeProfileCredentialProvider({
      sso: () => async () => credentials("sso"),
      fallback: () => async () => {
        fallbackCalls += 1
        return credentials("stale-static")
      }
    })

    const identity = await provider("dev-administratoraccess")

    assert.strictEqual(identity.accessKeyId, "sso")
    assert.strictEqual(fallbackCalls, 0)
  })

  it("uses the standard chain when the profile is not SSO-configured", async () => {
    const provider = makeProfileCredentialProvider({
      sso: () => async () => {
        throw Object.assign(new Error("not SSO"), { tryNextLink: true })
      },
      fallback: () => async () => credentials("standard-chain")
    })

    const identity = await provider("static-profile")

    assert.strictEqual(identity.accessKeyId, "standard-chain")
  })

  it("does not hide an expired SSO session behind stale static credentials", async () => {
    const expired = Object.assign(new Error("SSO session expired"), { tryNextLink: false })
    let fallbackCalls = 0
    const provider = makeProfileCredentialProvider({
      sso: () => async () => Promise.reject(expired),
      fallback: () => async () => {
        fallbackCalls += 1
        return credentials("stale-static")
      }
    })

    await expect(provider("expired-sso")).rejects.toBe(expired)
    assert.strictEqual(fallbackCalls, 0)
  })

  describe("default SDK providers", () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.layer(Layer.merge(NodeServices.layer, Default))((it) => {
      it.effect("resolves the default profile from shared config, never ambient credentials", () =>
        Effect.scoped(
          Effect.gen(function*() {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "aws-default-profile-" })
            const configFile = path.join(directory, "config")
            const credentialsFile = path.join(directory, "credentials")
            yield* fileSystem.writeFileString(configFile, "[default]\nregion = eu-west-1\n")
            yield* fileSystem.writeFileString(
              credentialsFile,
              "[default]\naws_access_key_id = AKIAPROFILEEXAMPLE\naws_secret_access_key = profile-secret\n"
            )
            vi.stubEnv("AWS_CONFIG_FILE", configFile)
            vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile)
            vi.stubEnv("AWS_PROFILE", undefined)
            vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENTEXAMPLE")
            vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret")

            const config = yield* AwsClientConfig
            const identity = yield* Effect.promise(() =>
              config.credentialProvider({ profile: "default", region: "eu-west-1" })
            )

            assert.strictEqual(identity.accessKeyId, "AKIAPROFILEEXAMPLE")
          })
        ))

      it.effect("does not fall back to ambient credentials for a profile missing from shared config", () =>
        Effect.scoped(
          Effect.gen(function*() {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "aws-missing-profile-" })
            const configFile = path.join(directory, "config")
            yield* fileSystem.writeFileString(configFile, "[profile other]\nregion = eu-west-1\n")
            vi.stubEnv("AWS_CONFIG_FILE", configFile)
            vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", path.join(directory, "credentials"))
            vi.stubEnv("AWS_PROFILE", undefined)
            vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENTEXAMPLE")
            vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret")

            const config = yield* AwsClientConfig
            const resolved = yield* Effect.tryPromise(() =>
              config.credentialProvider({ profile: "missing", region: "eu-west-1" })
            ).pipe(Effect.result)

            assert.strictEqual(resolved._tag, "Failure")
          })
        ))
    })
  })
})
