import { assert, describe, expect, it } from "@effect/vitest"

import { makeProfileCredentialProvider } from "../src/AwsClientConfig/internal/ProfileCredentialProvider.js"

const credentials = (accessKeyId: string) => ({
  accessKeyId,
  secretAccessKey: "secret"
})

describe("AWS profile credential resolution", () => {
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
