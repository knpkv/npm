/** `apps.json` as the hub reads it, the spawn handshake, and an app's `hubApp` package field. */
import { describe, expect, it } from "@effect/vitest"
import { Redacted, Result, Schema } from "effect"
import { AppClientAssets, AppsConfig, HubAppPackageField, HubHandshake } from "../src/manifest.js"

const decodeConfig = Schema.decodeUnknownResult(AppsConfig, { onExcessProperty: "error" })

const usage = {
  id: "usage",
  package: "@knpkv/herdr-usage",
  version: "0.3.0",
  dir: "/home/owner/.local/share/herdr-hub/hub-apps/usage/0.3.0",
  bin: "node_modules/@knpkv/herdr-usage/dist/bin.js",
  enabled: true,
  memoryMb: 512,
  allowScripts: false
}

describe("AppsConfig", () => {
  it("reads v2: who writes it, which scopes are trusted, and each app's prefix and script", () => {
    const config = { v: 2, managedBy: "cli", trust: { scopes: ["@knpkv"] }, apps: [usage] }
    expect(decodeConfig(config)).toEqual(Result.succeed(config))
  })

  // Only nix or the CLI writes it; anything else is a hand edit the hub can't trust to be complete.
  it("refuses a v2 file with an unknown writer, an unknown key, or a heap cap outside its range", () => {
    for (
      const config of [
        { v: 2, managedBy: "me", trust: { scopes: [] }, apps: [] },
        { v: 2, managedBy: "cli", trust: { scopes: [] }, apps: [{ ...usage, socket: "/run/usage.sock" }] },
        { v: 2, managedBy: "cli", trust: { scopes: [] }, apps: [{ ...usage, memoryMb: 8 }] }
      ]
    ) {
      expect(Result.isFailure(decodeConfig(config))).toBe(true)
    }
  })

  // No v1 file was ever written outside tests, so there is nothing to migrate: v1 is refused.
  it("refuses v1, P0's socket list", () => {
    const config = { v: 1, apps: [{ id: "usage", socket: "/run/user/1000/hub-apps/usage.sock" }] }
    expect(Result.isFailure(decodeConfig(config))).toBe(true)
  })
})

describe("HubHandshake", () => {
  // The token and secret stay redacted in memory, so a logged handshake shows neither.
  it("decodes the token and secret as redacted values", () => {
    const line = JSON.stringify({
      v: 1,
      endpoint: "\\\\.\\pipe\\herdr-hub-owner-usage-0123456789abcdef",
      hubUrl: "http://127.0.0.1:3111",
      hubToken: "token-value",
      appSecret: "secret-value"
    })
    const handshake = Schema.decodeUnknownSync(Schema.fromJsonString(HubHandshake))(line)
    expect([Redacted.value(handshake.hubToken), Redacted.value(handshake.appSecret)]).toEqual([
      "token-value",
      "secret-value"
    ])
    expect(String(handshake.appSecret)).not.toContain("secret-value")
  })
})

describe("HubAppPackageField", () => {
  it("names the script, the contract and the services an app may call", () => {
    const field = { bin: "dist/bin.js", contract: 1, services: ["fleet.read", "host"] }
    expect(Schema.decodeUnknownSync(HubAppPackageField)(field)).toEqual(field)
    expect(Result.isFailure(Schema.decodeUnknownResult(HubAppPackageField)({ ...field, contract: 2 }))).toBe(true)
  })
})

// A shell loads `/apps/<id>/app/assets/<path>`; a dot segment would resolve outside that prefix in the browser.
describe("AppClientAssets", () => {
  const decodeAssets = Schema.decodeUnknownResult(AppClientAssets)
  it("takes nested file paths and refuses dot segments", () => {
    expect(Result.isSuccess(decodeAssets({ entry: "client.js", css: ["styles/client.v2.css"] }))).toBe(true)
    for (const path of ["../client.js", "a/../../client.js", "./client.js", "a/./b.js", ".", "..", "a/.."]) {
      expect(Result.isFailure(decodeAssets({ entry: path, css: [] })), path).toBe(true)
      expect(Result.isFailure(decodeAssets({ entry: "client.js", css: [path] })), path).toBe(true)
    }
  })
})
