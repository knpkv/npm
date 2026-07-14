import { NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"

import { DEFAULT_HTTP_SECURITY_LIMITS } from "../../src/server/http/security/HttpLimits.js"
import {
  controlCenterTransportProtocol,
  DirectTlsServerError,
  makeDirectTlsNodeServer,
  NODE_LISTENER_SECURITY_POLICY
} from "../../src/server/runtime/NodeTransport.js"
import { requestUrlBoundaryLayer } from "../../src/server/runtime/RequestUrlBoundary.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import { SecretStore } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const directTls = {
  certificateRef: Schema.decodeSync(SecretRef)(`secret_${"a".repeat(64)}`),
  privateKeyRef: Schema.decodeSync(SecretRef)(`secret_${"b".repeat(64)}`)
}

const VALID_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUHfz3PClWK5QROZYqDJuGXXjeL1owCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNY29udHJvbC5sb2NhbDAeFw0yNjA3MTQwMjEyMjRaFw0zNjA3
MTEwMjEyMjRaMBgxFjAUBgNVBAMMDWNvbnRyb2wubG9jYWwwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAT5EJg/AwwxDpossVx63mWvrbrKvkY+84MQCWxvhCqdcssQ
cz45xRC6bUtVp8UZ2aLTeysNZBE6nOt/GCsY5pedo1MwUTAdBgNVHQ4EFgQUbc6g
97HBvHSvWLUoQPIK4ypUH90wHwYDVR0jBBgwFoAUbc6g97HBvHSvWLUoQPIK4ypU
H90wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiANJfhWmIS4hUAO
yUqbO+KOBKVflwaqxmgSICe5Auv4BAIhAKMzQOaQJTEAcq54hhiYBj3DB4Ja3ZJX
nGO+GoUNEtCV
-----END CERTIFICATE-----`

const VALID_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1O/MTCX6Ovse9e/n
q4oa67yiKHD7PQs9rj8kuV3XKoOhRANCAAT5EJg/AwwxDpossVx63mWvrbrKvkY+
84MQCWxvhCqdcssQcz45xRC6bUtVp8UZ2aLTeysNZBE6nOt/GCsY5ped
-----END PRIVATE KEY-----`

const urlBoundaryTestLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/ok", HttpServerResponse.text("ok")),
  requestUrlBoundaryLayer,
  HttpServer.layerServices
).pipe(
  Layer.provide([
    NodeHttpServer.layerHttpServices,
    NodeServices.layer
  ])
)

describe("Control Center Node transport", () => {
  it.effect("maps all validated bind modes to their real listener protocol", () =>
    Effect.gen(function*() {
      const loopback = yield* decodeBindConfig({})
      const insecureLan = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 5173,
        publicOrigin: "http://192.168.1.42:5173",
        allowedHosts: ["192.168.1.42:5173"],
        allowedOrigins: ["http://192.168.1.42:5173"],
        allowInsecureLan: true
      })
      const trustedProxy = yield* decodeBindConfig({
        host: "0.0.0.0",
        publicOrigin: "https://control.local",
        allowedHosts: ["control.local"],
        allowedOrigins: ["https://control.local"],
        trustedProxyAddresses: ["10.0.0.1"]
      })
      const tls = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls
      })

      assert.deepStrictEqual(
        [loopback, insecureLan, trustedProxy, tls].map((config) => ({
          policy: config.transportPolicy,
          protocol: controlCenterTransportProtocol(config)
        })),
        [
          { policy: "loopback-http", protocol: "http" },
          { policy: "insecure-lan", protocol: "http" },
          { policy: "trusted-tls-proxy", protocol: "http" },
          { policy: "direct-tls", protocol: "https" }
        ]
      )
    }))

  it("applies Node parser and timeout budgets from the shared HTTP policy", () => {
    assert.strictEqual(
      NODE_LISTENER_SECURITY_POLICY.maximumHeaderBytes,
      DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderBytes
    )
    assert.strictEqual(
      NODE_LISTENER_SECURITY_POLICY.maximumHeaderCount,
      DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderCount
    )
    assert.strictEqual(NODE_LISTENER_SECURITY_POLICY.headersTimeoutMilliseconds, 15_000)
    assert.strictEqual(NODE_LISTENER_SECURITY_POLICY.requestTimeoutMilliseconds, 30_000)
  })

  it.effect("releases direct-TLS source leases before returning from construction", () =>
    Effect.gen(function*() {
      const certificateBytes = Uint8Array.from([1, 2, 3])
      const privateKeyBytes = Uint8Array.from([4, 5, 6])
      const secretStore: SecretStore["Service"] = {
        create: () => Effect.die("not used"),
        rotate: () => Effect.die("not used"),
        remove: () => Effect.die("not used"),
        resolve: (ref) => {
          const bytes = ref === directTls.certificateRef ? certificateBytes : privateKeyBytes
          return Effect.acquireRelease(
            Effect.succeed({
              byteLength: bytes.byteLength,
              withBytes: (use) => use(bytes),
              toJSON: (): "[REDACTED]" => "[REDACTED]",
              toString: (): "[REDACTED]" => "[REDACTED]"
            }),
            () => Effect.sync(() => bytes.fill(0))
          )
        }
      }
      const bindConfig = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls
      })

      const result = yield* makeDirectTlsNodeServer(bindConfig).pipe(
        Effect.provideService(SecretStore, secretStore),
        Effect.result
      )

      assert.isTrue(result._tag === "Failure")
      if (result._tag === "Failure") assert.instanceOf(result.failure, DirectTlsServerError)
      assert.deepStrictEqual(Array.from(certificateBytes), [0, 0, 0])
      assert.deepStrictEqual(Array.from(privateKeyBytes), [0, 0, 0])
    }))

  it.effect("constructs HTTPS from valid material and zeroes both source leases", () =>
    Effect.gen(function*() {
      const certificateBytes = new TextEncoder().encode(VALID_CERTIFICATE)
      const privateKeyBytes = new TextEncoder().encode(VALID_PRIVATE_KEY)
      const certificateLength = certificateBytes.byteLength
      const privateKeyLength = privateKeyBytes.byteLength
      const secretStore: SecretStore["Service"] = {
        create: () => Effect.die("not used"),
        rotate: () => Effect.die("not used"),
        remove: () => Effect.die("not used"),
        resolve: (ref) => {
          const bytes = ref === directTls.certificateRef ? certificateBytes : privateKeyBytes
          return Effect.acquireRelease(
            Effect.succeed({
              byteLength: bytes.byteLength,
              withBytes: (use) => use(bytes),
              toJSON: (): "[REDACTED]" => "[REDACTED]",
              toString: (): "[REDACTED]" => "[REDACTED]"
            }),
            () => Effect.sync(() => bytes.fill(0))
          )
        }
      }
      const bindConfig = yield* decodeBindConfig({
        host: "0.0.0.0",
        port: 8443,
        publicOrigin: "https://control.local:8443",
        allowedHosts: ["control.local:8443"],
        allowedOrigins: ["https://control.local:8443"],
        directTls
      })

      const server = yield* makeDirectTlsNodeServer(bindConfig).pipe(
        Effect.provideService(SecretStore, secretStore)
      )

      assert.isDefined(server)
      assert.deepStrictEqual(Array.from(certificateBytes), Array.from({ length: certificateLength }, () => 0))
      assert.deepStrictEqual(Array.from(privateKeyBytes), Array.from({ length: privateKeyLength }, () => 0))
    }))

  it("rejects an oversized request target before route selection", async () => {
    const webHandler = HttpRouter.toWebHandler(urlBoundaryTestLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request(`http://127.0.0.1:4173/${"a".repeat(8 * 1024)}`)
      )

      assert.strictEqual(response.status, 414)
      assert.strictEqual(response.headers.get("cache-control"), "no-store")
      assert.strictEqual(await response.text(), "URI Too Long")
    } finally {
      await webHandler.dispose()
    }
  })
})
