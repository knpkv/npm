import { assert, describe, expect, it } from "@effect/vitest"

import { makeProfileCredentialProvider, profileSourcesOf, staticKeysShadowSso } from "../src/AwsProfileCredentials.js"

const credentials = (accessKeyId: string) => ({
  accessKeyId,
  secretAccessKey: "secret"
})

describe("AWS profile credential resolution", () => {
  it("uses empty provider options for the default profile", async () => {
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
      ["sso", {}],
      ["fallback", {}]
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
})

describe("AWS profile sources", () => {
  const ssoConfig = { "profile-sso": { sso_session: "corp", region: "eu-west-1" } }

  it("flags static keys that shadow an SSO-configured profile", () => {
    const sources = profileSourcesOf("profile-sso", {
      configFile: ssoConfig,
      credentialsFile: { "profile-sso": { aws_access_key_id: "ASIAFIXTURE" } }
    })
    assert.deepStrictEqual(sources, { profile: "profile-sso", ssoConfigured: true, staticKeys: true })
    assert.isTrue(staticKeysShadowSso(sources))
  })

  it("does not flag a static-only profile", () => {
    const sources = profileSourcesOf("static", {
      configFile: { static: { region: "eu-west-1" } },
      credentialsFile: { static: { aws_access_key_id: "AKIAFIXTURE" } }
    })
    assert.isFalse(staticKeysShadowSso(sources))
  })

  it("does not flag an SSO profile without a credentials section", () => {
    assert.isFalse(staticKeysShadowSso(profileSourcesOf("profile-sso", { configFile: ssoConfig, credentialsFile: {} })))
  })

  it("recognises the legacy sso_start_url form", () => {
    const sources = profileSourcesOf("legacy", {
      configFile: { legacy: { sso_start_url: "https://example.awsapps.com/start" } },
      credentialsFile: { legacy: { aws_access_key_id: "ASIAFIXTURE" } }
    })
    assert.isTrue(staticKeysShadowSso(sources))
  })
})
