import { NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Result, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError } from "effect/unstable/httpapi"

import { ApiBindConfiguration } from "../../src/server/api/ApiConfiguration.js"
import { clientRateLimitKey, requestBoundaryLayer } from "../../src/server/api/RequestBoundary.js"
import { consumeRequestToken, RequestLimitPolicy, requestRateLimiterLayer } from "../../src/server/api/RequestLimits.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const bindLayer = Layer.effect(ApiBindConfiguration, decodeBindConfig({}))
const limitPolicyLayer = Layer.succeed(RequestLimitPolicy, {
  maximumBodyBytes: 256 * 1024,
  pairing: { limit: 1, window: Duration.minutes(1) },
  read: { limit: 1, window: Duration.minutes(1) },
  mutation: { limit: 1, window: Duration.minutes(1) },
  agent: { limit: 1, window: Duration.minutes(1) },
  media: { limit: 1, window: Duration.minutes(1) },
  readTimeout: Duration.seconds(5),
  mutationTimeout: Duration.seconds(5),
  agentTimeout: Duration.seconds(5)
})

const schemaDefect = (kind: HttpApiError.HttpApiSchemaError["kind"]) =>
  Schema.decodeUnknownEffect(Schema.String)(42).pipe(
    Effect.mapError((cause) => new HttpApiError.HttpApiSchemaError({ cause, kind })),
    Effect.orDie,
    Effect.as(HttpServerResponse.text("unreachable"))
  )

const webHandlerLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/api/v1/session/pair", HttpServerResponse.text("ok")),
  HttpRouter.add("GET", "/api/ping", HttpServerResponse.text("pong")),
  HttpRouter.add("GET", "/api/schema-request", schemaDefect("Payload")),
  HttpRouter.add("POST", "/api/schema-response", schemaDefect("Body")),
  HttpRouter.add("GET", "/asset.js", HttpServerResponse.text("asset")),
  requestBoundaryLayer,
  HttpServer.layerServices
).pipe(
  Layer.provide([
    bindLayer,
    limitPolicyLayer,
    requestRateLimiterLayer,
    NodeHttpServer.layerHttpServices,
    NodeServices.layer
  ])
)

describe("API request boundary", () => {
  it.effect("isolates trusted proxied clients while ignoring spoofed forwarding headers", () =>
    Effect.gen(function*() {
      const trustedProxy = "10.0.0.1"
      const firstClient = clientRateLimitKey([trustedProxy], trustedProxy, "192.168.1.10")
      const secondClient = clientRateLimitKey([trustedProxy], trustedProxy, "192.168.1.11")
      const untrustedFirst = clientRateLimitKey([trustedProxy], "203.0.113.9", "192.168.1.10")
      const untrustedSecond = clientRateLimitKey([trustedProxy], "203.0.113.9", "192.168.1.11")

      assert.notStrictEqual(firstClient, secondClient)
      assert.strictEqual(untrustedFirst, untrustedSecond)
      assert.strictEqual(
        clientRateLimitKey([trustedProxy], trustedProxy, "192.168.1.10, 192.168.1.11"),
        `peer:${trustedProxy}`
      )

      yield* consumeRequestToken("read", firstClient)
      const firstExhausted = yield* consumeRequestToken("read", firstClient).pipe(Effect.result)
      assert.isTrue(Result.isFailure(firstExhausted))
      yield* consumeRequestToken("read", secondClient)
    }).pipe(Effect.provide([limitPolicyLayer, requestRateLimiterLayer])))

  it("rejects compressed JSON with typed correlation and global browser headers", async () => {
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/session/pair", {
          method: "POST",
          headers: {
            "content-encoding": "gzip",
            "content-type": "application/json",
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-correlation-id": "test-boundary-1"
          },
          body: "{}"
        })
      )
      const responseText = await response.text()
      const body: unknown = responseText === "" ? null : JSON.parse(responseText)

      assert.strictEqual(response.status, 400)
      assert.match(response.headers.get("x-correlation-id") ?? "", /^[A-Za-z0-9._:-]+$/u)
      assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff")
      assert.include(response.headers.get("content-security-policy") ?? "", "default-src 'none'")
      assert.deepInclude(body, {
        _tag: "InvalidRequestApiError",
        code: "invalid-request",
        correlationId: "test-boundary-1"
      })
    } finally {
      await webHandler.dispose()
    }
  })

  it("does not spend API rate-limit tokens on static traffic", async () => {
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      for (const correlationId of ["static-1", "static-2"]) {
        const response = await webHandler.handler(
          new Request("http://127.0.0.1:4173/asset.js", {
            headers: { "x-correlation-id": correlationId }
          })
        )
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.headers.get("x-correlation-id"), correlationId)
      }

      const firstApiResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/ping", {
          headers: { "x-correlation-id": "api-1" }
        })
      )
      const secondApiResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/ping", {
          headers: { "x-correlation-id": "api-2" }
        })
      )

      assert.strictEqual(firstApiResponse.status, 200)
      assert.strictEqual(firstApiResponse.headers.get("cache-control"), "no-store")
      assert.strictEqual(secondApiResponse.status, 429)
    } finally {
      await webHandler.dispose()
    }
  })

  it("marks a successful pairing response as non-cacheable", async () => {
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/session/pair", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173"
          },
          body: "{}"
        })
      )

      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("cache-control"), "no-store")
    } finally {
      await webHandler.dispose()
    }
  })

  it("distinguishes malformed client data from invalid handler output", async () => {
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const invalidRequest = await webHandler.handler(
        new Request(
          "http://127.0.0.1:4173/api/schema-request",
          { headers: { "x-correlation-id": "schema-request" } }
        )
      )
      const invalidResponse = await webHandler.handler(
        new Request(
          "http://127.0.0.1:4173/api/schema-response",
          {
            method: "POST",
            headers: { "x-correlation-id": "schema-response" }
          }
        )
      )

      assert.strictEqual(invalidRequest.status, 400)
      assert.deepInclude(await invalidRequest.json(), {
        _tag: "InvalidRequestApiError",
        correlationId: "schema-request"
      })
      assert.strictEqual(invalidResponse.status, 503)
      assert.deepInclude(await invalidResponse.json(), {
        _tag: "ServiceUnavailableApiError",
        correlationId: "schema-response"
      })
    } finally {
      await webHandler.dispose()
    }
  })

  it("rejects oversized request metadata before serving a static fallback", async () => {
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request(`http://127.0.0.1:4173/${"a".repeat(8 * 1024)}`, {
          headers: { "x-correlation-id": "metadata-limit" }
        })
      )
      const body: unknown = await response.json()

      assert.strictEqual(response.status, 400)
      assert.strictEqual(response.headers.get("x-correlation-id"), "metadata-limit")
      assert.deepInclude(body, {
        _tag: "InvalidRequestApiError",
        code: "invalid-request"
      })
    } finally {
      await webHandler.dispose()
    }
  })
})
