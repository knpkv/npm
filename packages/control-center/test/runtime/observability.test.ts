import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import type { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { controlCenterTelemetryLayer } from "../../src/server/observability.js"

interface CapturedRequest {
  readonly contentType: string | null
  readonly url: string
}

const preprocessRequest = (
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError> => Effect.succeed(request)

class CapturedRequests extends Context.Service<
  CapturedRequests,
  {
    readonly requests: Effect.Effect<ReadonlyArray<CapturedRequest>>
  }
>()("@knpkv/control-center/test/CapturedRequests") {}

const HttpClientLayer = Layer.effectContext(
  Effect.gen(function*() {
    const requests = yield* Ref.make<ReadonlyArray<CapturedRequest>>([])
    const httpClient = HttpClient.makeWith(
      Effect.fnUntraced(function*(requestEffect) {
        const request = yield* requestEffect
        yield* Ref.update(requests, (current) => [
          ...current,
          { contentType: request.headers["content-type"] ?? null, url: request.url }
        ])
        return HttpClientResponse.fromWeb(request, new Response())
      }),
      preprocessRequest
    )

    return Context.make(HttpClient.HttpClient, httpClient).pipe(
      Context.add(CapturedRequests, CapturedRequests.of({ requests: Ref.get(requests) }))
    )
  })
)

const testLayer = (env: Record<string, string>) =>
  controlCenterTelemetryLayer.pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
  )

describe("Control Center observability", () => {
  it.effect("exports traces and logs to a configured OTLP base endpoint without exporting metrics", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Motel log probe")
      yield* Effect.void.pipe(Effect.withSpan("motel.trace-probe"))
      yield* Metric.update(Metric.counter("motel_metric_probe"), 1)

      const capturedRequests = yield* CapturedRequests
      const requests = yield* capturedRequests.requests
      const urls = requests.map((request) => request.url)

      assert.include(urls, "http://127.0.0.1:27686/v1/logs")
      assert.include(urls, "http://127.0.0.1:27686/v1/traces")
      assert.notInclude(urls, "http://127.0.0.1:27686/v1/metrics")
    }).pipe(
      Effect.provide(
        testLayer({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:27686",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "1",
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1"
        })
      )
    ))

  it.effect("honors Lensflare's signal-specific dataset endpoints", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Lensflare log probe")
      yield* Effect.void.pipe(Effect.withSpan("lensflare.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      const requests = yield* capturedRequests.requests
      const urls = requests.map((request) => request.url)

      assert.include(urls, "http://127.0.0.1:43110/ingest/otlp/v1/logs/control-center")
      assert.include(urls, "http://127.0.0.1:43110/ingest/otlp/v1/traces/control-center")
      assert.isTrue(urls.every((url) =>
        url === "http://127.0.0.1:43110/ingest/otlp/v1/logs/control-center" ||
        url === "http://127.0.0.1:43110/ingest/otlp/v1/traces/control-center"
      ))
    }).pipe(
      Effect.provide(
        testLayer({
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:43110/ingest/otlp/v1/logs/control-center",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:43110/ingest/otlp/v1/traces/control-center",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "1",
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1"
        })
      )
    ))

  it.effect("uses the standard OTLP endpoint and protobuf protocol defaults", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Default OTLP log probe")
      yield* Effect.void.pipe(Effect.withSpan("default-otlp.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      const requests = yield* capturedRequests.requests

      assert.deepInclude(requests, {
        contentType: "application/x-protobuf",
        url: "http://localhost:4318/v1/logs"
      })
      assert.deepInclude(requests, {
        contentType: "application/x-protobuf",
        url: "http://localhost:4318/v1/traces"
      })
    }).pipe(
      Effect.provide(
        testLayer({
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "1",
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1"
        })
      )
    ))

  it.effect("honors signal-specific OTLP HTTP protocols", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Mixed protocol log probe")
      yield* Effect.void.pipe(Effect.withSpan("mixed-protocol.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      const requests = yield* capturedRequests.requests

      assert.deepInclude(requests, {
        contentType: "application/json",
        url: "http://collector.test/v1/logs"
      })
      assert.deepInclude(requests, {
        contentType: "application/x-protobuf",
        url: "http://collector.test/v1/traces"
      })
    }).pipe(
      Effect.provide(
        testLayer({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
          OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "1",
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1"
        })
      )
    ))

  it.effect("stays local when OTLP exporters are not enabled", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Local-only log probe")
      yield* Effect.void.pipe(Effect.withSpan("local-only.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      assert.deepStrictEqual(yield* capturedRequests.requests, [])
    }).pipe(Effect.provide(testLayer({}))))

  it.effect("ignores malformed endpoints while exporters are inactive", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Inactive malformed endpoint probe")
      yield* Effect.void.pipe(Effect.withSpan("inactive-malformed.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      assert.deepStrictEqual(yield* capturedRequests.requests, [])
    }).pipe(
      Effect.provide(testLayer({
        OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "also-not-a-url",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "still-not-a-url"
      }))
    ))

  it.effect("rejects malformed signal-specific endpoints while their exporters are active", () =>
    Effect.gen(function*() {
      const fixtures: ReadonlyArray<Readonly<Record<string, string>>> = [
        {
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not-a-url",
          OTEL_LOGS_EXPORTER: "otlp"
        },
        {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not-a-url",
          OTEL_TRACES_EXPORTER: "otlp"
        }
      ]

      for (const environment of fixtures) {
        const result = yield* Layer.build(testLayer(environment)).pipe(Effect.scoped, Effect.result)
        assert.isTrue(Result.isFailure(result))
      }
    }))

  it.effect("ignores malformed endpoints when the OpenTelemetry SDK is disabled", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("Disabled SDK malformed endpoint probe")
      yield* Effect.void.pipe(Effect.withSpan("disabled-sdk-malformed.trace-probe"))

      const capturedRequests = yield* CapturedRequests
      assert.deepStrictEqual(yield* capturedRequests.requests, [])
    }).pipe(
      Effect.provide(testLayer({
        OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_SDK_DISABLED: "true"
      }))
    ))
})
