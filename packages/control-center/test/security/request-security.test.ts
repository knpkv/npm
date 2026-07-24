import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Result, Schema } from "effect"

import { isAuthenticatedReadTransportEndpoint } from "../../src/server/api/ApiMiddleware.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import {
  authorizeAuthenticatedMutation,
  authorizeAuthenticatedRead,
  authorizeAuthenticatedReadPost,
  authorizeInsecureLanCapability,
  authorizeRequest,
  decodeBindConfig,
  effectiveReachableUrls,
  hashCsrfToken,
  sessionCookiePolicy,
  verifyCsrfToken
} from "../../src/server/security/index.js"
import type { InsecureLanCapability } from "../../src/server/security/index.js"

const directTls = {
  certificateRef: Schema.decodeSync(SecretRef)(`secret_${"a".repeat(64)}`),
  privateKeyRef: Schema.decodeSync(SecretRef)(`secret_${"b".repeat(64)}`)
}

const request = {
  method: "GET",
  host: "127.0.0.1:4173",
  origin: null,
  csrfToken: null,
  forwardedHost: null,
  forwardedProto: null,
  remoteAddress: "127.0.0.1"
}

describe("bind and request security", () => {
  it.effect("authorizes only the bounded diff content POST as a read transport", () =>
    Effect.gen(function*() {
      const config = yield* decodeBindConfig({})
      assert.isTrue(isAuthenticatedReadTransportEndpoint("diff", "content", "POST"))
      assert.isFalse(isAuthenticatedReadTransportEndpoint("agent", "turn", "POST"))

      yield* authorizeAuthenticatedReadPost({
        capability: "policy-administration",
        config,
        request: {
          ...request,
          method: "POST",
          origin: "http://127.0.0.1:4173"
        }
      })

      const foreignOrigin = yield* authorizeAuthenticatedReadPost({
        capability: "policy-administration",
        config,
        request: {
          ...request,
          method: "POST",
          origin: "http://attacker.example"
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(foreignOrigin))
      if (Result.isFailure(foreignOrigin)) assert.strictEqual(foreignOrigin.failure.reason, "origin-rejected")
    }))

  it.effect("defaults to one explicit loopback URL and strict session cookie", () =>
    Effect.gen(function*() {
      const config = yield* decodeBindConfig({})
      assert.strictEqual(config.host, "127.0.0.1")
      assert.strictEqual(config.port, 4173)
      assert.strictEqual(config.publicOrigin, "http://127.0.0.1:4173")
      assert.strictEqual(config.transportPolicy, "loopback-http")
      assert.strictEqual(config.directTls, null)
      assert.deepStrictEqual(effectiveReachableUrls(config, ["192.168.1.42"]), ["http://127.0.0.1:4173"])
      assert.deepStrictEqual(sessionCookiePolicy(config), {
        name: "cc_session",
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: false
      })
    }))

  it.effect("requires explicit origin, allowlists, and transport policy for LAN binding", () =>
    Effect.gen(function*() {
      const missingOrigin = yield* decodeBindConfig({ host: "0.0.0.0" }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingOrigin))
      if (Result.isFailure(missingOrigin)) {
        assert.strictEqual(missingOrigin.failure.reason, "lan-requires-public-origin")
      }

      const deceptiveLoopbackName = yield* decodeBindConfig({ host: "127.attacker.example" }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(deceptiveLoopbackName))
      if (Result.isFailure(deceptiveLoopbackName)) {
        assert.strictEqual(deceptiveLoopbackName.failure.reason, "lan-requires-public-origin")
      }

      const wildcardPublicOrigin = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 5173,
        publicOrigin: "http://0.0.0.0:5173",
        allowedHosts: ["0.0.0.0:5173"],
        allowedOrigins: ["http://0.0.0.0:5173"],
        allowInsecureLan: true
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(wildcardPublicOrigin))

      const fictionalLoopbackTls = yield* decodeBindConfig({
        publicOrigin: "https://127.0.0.1:4173"
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(fictionalLoopbackTls))

      const missingHosts = yield* decodeBindConfig({
        host: "0.0.0.0",
        publicOrigin: "https://control.local:8443",
        directTls
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingHosts))
      if (Result.isFailure(missingHosts)) {
        assert.strictEqual(missingHosts.failure.reason, "lan-requires-host-allowlist")
      }

      const config = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls
      })
      assert.strictEqual(config.cookieSecure, true)
      assert.deepStrictEqual(config.directTls, directTls)
      assert.deepStrictEqual(effectiveReachableUrls(config, ["192.168.1.42", "8.8.8.8", "999.1.1.1", "not an ip"]), [
        "https://control.local:8443"
      ])
      assert.isFalse(effectiveReachableUrls(config, ["192.168.1.42"]).some((url) => url.includes("0.0.0.0")))

      const legacyBoolean = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls: true
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(legacyBoolean))
      if (Result.isFailure(legacyBoolean)) {
        assert.strictEqual(legacyBoolean.failure.reason, "invalid-input")
      }

      const missingPrivateKey = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls: { certificateRef: directTls.certificateRef }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingPrivateKey))
      if (Result.isFailure(missingPrivateKey)) {
        assert.strictEqual(missingPrivateKey.failure.reason, "invalid-input")
      }
    }))

  it.effect("rejects hostile origins, hosts, credentials, and ambiguous transport", () =>
    Effect.gen(function*() {
      const secretCanary = "never-serialize-origin-password"
      const cases = [
        {
          publicOrigin: `https://owner:${secretCanary}@control.local`,
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          directTls
        },
        {
          publicOrigin: "http://control.local",
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["http://control.local"],
          directTls
        },
        {
          publicOrigin: "https://control.local",
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          directTls,
          trustedProxyAddresses: ["10.0.0.1"]
        },
        {
          publicOrigin: "https://control.local",
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          trustedProxyAddresses: ["10.0.0.1"],
          allowInsecureLan: true
        },
        {
          publicOrigin: "https://control.local",
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          directTls,
          allowInsecureLan: true
        },
        {
          publicOrigin: "https://control.local",
          host: "0.0.0.0",
          port: 8443,
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          directTls
        },
        {
          publicOrigin: "https://control.local",
          host: "0.0.0.0",
          allowedHosts: ["control.local"],
          allowedOrigins: ["https://control.local"],
          trustedProxyAddresses: ["999.1.1.1"]
        }
      ]
      for (const value of cases) {
        const result = yield* decodeBindConfig(value).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.notInclude(JSON.stringify(result), secretCanary)
      }
    }))

  it.effect("enforces exact Host and Origin while ignoring untrusted forwarded headers", () =>
    Effect.gen(function*() {
      const config = yield* decodeBindConfig({})
      const csrfToken = "12".repeat(32)
      const expectedCsrfDigest = yield* hashCsrfToken(csrfToken)
      yield* authorizeRequest(config, request, "authenticated-read")

      const foreignRead = yield* authorizeRequest(
        config,
        { ...request, origin: "http://attacker.example" },
        "authenticated-read"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(foreignRead))
      if (Result.isFailure(foreignRead)) assert.strictEqual(foreignRead.failure.reason, "origin-rejected")

      const badHost = yield* authorizeRequest(
        config,
        {
          ...request,
          host: "attacker.example",
          forwardedHost: "127.0.0.1:4173",
          forwardedProto: "https",
          remoteAddress: "203.0.113.9"
        },
        "authenticated-read"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(badHost))
      if (Result.isFailure(badHost)) assert.strictEqual(badHost.failure.reason, "host-rejected")

      const missingOrigin = yield* authorizeAuthenticatedMutation(
        {
          config,
          request: { ...request, method: "POST", csrfToken },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingOrigin))
      if (Result.isFailure(missingOrigin)) {
        assert.strictEqual(missingOrigin.failure.reason, "origin-required")
      }

      const badOrigin = yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...request,
            method: "POST",
            origin: "http://attacker.example",
            csrfToken
          },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(badOrigin))
      if (Result.isFailure(badOrigin)) assert.strictEqual(badOrigin.failure.reason, "origin-rejected")

      const missingCsrf = yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...request,
            method: "POST",
            origin: "http://127.0.0.1:4173"
          },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingCsrf))
      if (Result.isFailure(missingCsrf)) assert.strictEqual(missingCsrf.failure.reason, "csrf-required")

      const arbitraryCsrf = yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...request,
            method: "POST",
            origin: "http://127.0.0.1:4173",
            csrfToken: "34".repeat(32)
          },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(arbitraryCsrf))
      if (Result.isFailure(arbitraryCsrf)) {
        assert.strictEqual(arbitraryCsrf.failure.reason, "csrf-rejected")
      }

      yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...request,
            method: "POST",
            origin: "http://127.0.0.1:4173",
            csrfToken
          },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      )

      yield* authorizeRequest(
        config,
        {
          ...request,
          method: "POST",
          origin: "http://127.0.0.1:4173"
        },
        "public-pair"
      )

      const safePublicPair = yield* authorizeRequest(config, request, "public-pair").pipe(Effect.result)
      assert.isTrue(Result.isFailure(safePublicPair))
      if (Result.isFailure(safePublicPair)) {
        assert.strictEqual(safePublicPair.failure.reason, "method-mismatch")
      }

      const tracePublicPair = yield* authorizeRequest(
        config,
        { ...request, method: "TRACE", origin: "http://127.0.0.1:4173" },
        "public-pair"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(tracePublicPair))
      if (Result.isFailure(tracePublicPair)) {
        assert.strictEqual(tracePublicPair.failure.reason, "method-mismatch")
      }

      const proxyConfig = yield* decodeBindConfig({
        host: "0.0.0.0",
        publicOrigin: "https://control.local",
        allowedHosts: ["control.local"],
        allowedOrigins: ["https://control.local"],
        trustedProxyAddresses: ["10.0.0.1"]
      })
      yield* authorizeRequest(
        proxyConfig,
        {
          ...request,
          host: "127.0.0.1:4173",
          forwardedHost: "control.local",
          forwardedProto: "https",
          remoteAddress: "10.0.0.1"
        },
        "authenticated-read"
      )
      const bypassedProxy = yield* authorizeRequest(
        proxyConfig,
        {
          ...request,
          host: "control.local",
          forwardedHost: "control.local",
          forwardedProto: "https",
          remoteAddress: "10.0.0.2"
        },
        "authenticated-read"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(bypassedProxy))
      if (Result.isFailure(bypassedProxy)) {
        assert.strictEqual(bypassedProxy.failure.reason, "proxy-rejected")
      }
      assert.deepStrictEqual(effectiveReachableUrls(proxyConfig, ["10.0.0.8"]), ["https://control.local"])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("verifies CSRF digests without retaining or returning token text", () =>
    Effect.gen(function*() {
      const secretCanary = "ab".repeat(32)
      const digest = yield* hashCsrfToken(secretCanary)
      assert.notInclude(digest, secretCanary)
      yield* verifyCsrfToken(secretCanary, digest)

      const rejected = yield* verifyCsrfToken("cd".repeat(32), digest).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) assert.strictEqual(rejected.failure.reason, "csrf-rejected")
      assert.notInclude(JSON.stringify(rejected), secretCanary)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("blocks agents and administration but permits ordinary release work on explicitly insecure LAN", () =>
    Effect.gen(function*() {
      const config = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 5173,
        publicOrigin: "http://192.168.1.42:5173",
        allowedHosts: ["192.168.1.42:5173", "192.168.1.43:5173"],
        allowedOrigins: ["http://192.168.1.42:5173", "http://192.168.1.43:5173"],
        allowInsecureLan: true
      })
      assert.deepStrictEqual(effectiveReachableUrls(config, ["192.168.1.42", "192.168.1.43", "192.168.1.44"]), [
        "http://192.168.1.42:5173",
        "http://192.168.1.43:5173"
      ])
      yield* authorizeInsecureLanCapability(config, "release-read")
      yield* authorizeInsecureLanCapability(config, "release-action")
      yield* authorizeInsecureLanCapability(config, "session-self-read")
      const restrictedCapabilities = [
        "release-agent",
        "provider-configuration",
        "policy-administration",
        "pairing-administration",
        "session-administration",
        "secret-inspection"
      ] satisfies ReadonlyArray<InsecureLanCapability>
      for (const capability of restrictedCapabilities) {
        const result = yield* authorizeInsecureLanCapability(config, capability).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.reason, "insecure-lan-capability-rejected")
        }
      }

      const insecureRequest = { ...request, host: "192.168.1.42:5173" }
      yield* authorizeAuthenticatedRead({
        config,
        request: insecureRequest,
        capability: "release-read"
      })

      const insecurePairing = yield* authorizeRequest(
        config,
        {
          ...insecureRequest,
          method: "POST",
          origin: "http://192.168.1.42:5173"
        },
        "public-pair"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(insecurePairing))
      if (Result.isFailure(insecurePairing)) {
        assert.strictEqual(insecurePairing.failure.reason, "insecure-lan-capability-rejected")
      }

      const csrfToken = "56".repeat(32)
      const expectedCsrfDigest = yield* hashCsrfToken(csrfToken)
      yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...insecureRequest,
            method: "POST",
            origin: "http://192.168.1.42:5173",
            csrfToken
          },
          capability: "release-action"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      )

      const composedAdministration = yield* authorizeAuthenticatedMutation(
        {
          config,
          request: {
            ...insecureRequest,
            method: "POST",
            origin: "http://192.168.1.42:5173",
            csrfToken
          },
          capability: "policy-administration"
        },
        (token) => verifyCsrfToken(Redacted.value(token), expectedCsrfDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(composedAdministration))
      if (Result.isFailure(composedAdministration)) {
        assert.strictEqual(composedAdministration.failure.reason, "insecure-lan-capability-rejected")
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
