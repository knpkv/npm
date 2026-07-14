import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"

import {
  authorizeRequestBody,
  HttpByteLimit,
  limitRequestBodyStream,
  securityHeaders
} from "../../../src/server/http/security/index.js"

const metadata = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  method: "POST",
  contentEncoding: null,
  contentLength: "12",
  contentType: "application/json; charset=utf-8",
  transferEncoding: null,
  ...overrides
})

describe("HTTP request and response policy", () => {
  it.effect("accepts bounded identity JSON and returns its trusted byte budget", () =>
    Effect.gen(function*() {
      const authorized = yield* authorizeRequestBody({ metadata: metadata(), expectsJson: true, maximumBytes: 12 })
      assert.strictEqual(authorized.declaredBytes, 12)
      assert.strictEqual(authorized.maximumBytes, 12)
    }))

  it.effect("rejects compressed, conflicting, oversized, safe-method, and wrong-MIME bodies", () =>
    Effect.gen(function*() {
      const attempts = [
        metadata({ contentEncoding: "gzip" }),
        metadata({ transferEncoding: "chunked" }),
        metadata({ contentLength: "13" }),
        metadata({ method: "GET" }),
        metadata({ contentType: "text/plain" })
      ]
      const reasons: Array<string> = []
      for (const attempt of attempts) {
        const result = yield* authorizeRequestBody({ metadata: attempt, expectsJson: true, maximumBytes: 12 }).pipe(
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) reasons.push(result.failure.reason)
      }
      assert.deepStrictEqual(reasons, [
        "compressed-body-rejected",
        "conflicting-length-headers",
        "body-too-large",
        "safe-method-body-rejected",
        "content-type-rejected"
      ])
    }))

  it.effect("counts actual chunk bytes and fails on the first byte above the limit", () =>
    Effect.gen(function*() {
      const limit = Schema.decodeSync(HttpByteLimit)(4)
      const accepted = yield* Stream.make(new Uint8Array(2), new Uint8Array(2)).pipe(
        (stream) => limitRequestBodyStream(stream, limit),
        Stream.runCollect
      )
      assert.deepStrictEqual(accepted.map((chunk) => chunk.byteLength), [2, 2])

      const rejected = yield* Stream.make(new Uint8Array(3), new Uint8Array(2)).pipe(
        (stream) => limitRequestBodyStream(stream, limit),
        Stream.runCollect,
        Effect.result
      )
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) assert.strictEqual(rejected.failure.reason, "body-too-large")
    }))

  it("emits a strict CSP everywhere and HSTS only for secure transport", () => {
    const insecure = securityHeaders({ isSecureTransport: false })
    assert.include(insecure["content-security-policy"], "default-src 'none'")
    assert.include(insecure["content-security-policy"], "script-src 'self'")
    assert.notInclude(insecure["content-security-policy"], "unsafe-inline")
    assert.notInclude(insecure["content-security-policy"], "unsafe-eval")
    assert.strictEqual(insecure["strict-transport-security"], undefined)
    assert.strictEqual(insecure["x-content-type-options"], "nosniff")

    const secure = securityHeaders({ isSecureTransport: true })
    assert.include(secure["content-security-policy"], "upgrade-insecure-requests")
    assert.strictEqual(secure["strict-transport-security"], "max-age=31536000")
  })
})
