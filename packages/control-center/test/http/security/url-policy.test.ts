import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  EgressUrl,
  ExternalNavigationUrl,
  isPublicIpAddress,
  MediaRef,
  PublicIpAddress,
  ResolvedTarget
} from "../../../src/server/http/security/index.js"

describe("external navigation and egress URL policy", () => {
  it("accepts HTTPS navigation but rejects active, credentialed, insecure, and bidi-obscured URLs", () => {
    const accepted = Schema.decodeUnknownResult(ExternalNavigationUrl)(
      "https://jira.example/browse/RPS-6307?q=1#activity"
    )
    assert.isTrue(Result.isSuccess(accepted))
    const rejected = [
      "javascript:alert(1)",
      "data:text/html,active-content",
      "http://jira.example/browse/RPS-6307",
      "https://user:secret@jira.example/",
      "https://jira.example/\u202eevil"
    ]
    for (const url of rejected) assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(ExternalNavigationUrl)(url)))
  })

  it("keeps egress stricter than browser navigation", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(EgressUrl)("https://media.example/avatar?id=42")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EgressUrl)("https://media.example/avatar#fragment")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EgressUrl)("https://media.example:8443/avatar")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EgressUrl)("https://media.example./avatar")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EgressUrl)("https://127.0.0.1/avatar")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EgressUrl)("https://2130706433/avatar")))
  })

  it("classifies canonical public addresses and rejects all common SSRF destinations", () => {
    const publicAddresses = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]
    const blockedAddresses = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.42",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "2130706433",
      "0177.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "3fff::1"
    ]
    for (const address of publicAddresses) {
      assert.isTrue(isPublicIpAddress(address))
      assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PublicIpAddress)(address)))
    }
    for (const address of blockedAddresses) {
      assert.isFalse(isPublicIpAddress(address), address)
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PublicIpAddress)(address)))
    }
  })

  it("binds a resolved address and family to the original hostname", () => {
    const target = Schema.decodeUnknownResult(ResolvedTarget)({
      url: "https://media.example/avatar",
      hostname: "media.example",
      port: 443,
      address: "8.8.8.8",
      family: 4
    })
    assert.isTrue(Result.isSuccess(target))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(ResolvedTarget)({
        url: "https://media.example/avatar",
        hostname: "evil.example",
        port: 443,
        address: "8.8.8.8",
        family: 4
      })
    ))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(ResolvedTarget)({
        url: "https://media.example/avatar",
        hostname: "media.example",
        port: 443,
        address: "8.8.8.8",
        family: 6
      })
    ))
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(MediaRef)(`media_${"a".repeat(64)}`)))
  })
})
