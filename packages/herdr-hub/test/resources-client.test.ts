// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { PreviewHostname, probePreview } from "../src/internal/host-resources/previews.js"
import { loadHostResources } from "../src/resources-client.js"
import { resourcesFixture } from "./superapp-browser/resources-fixture.js"

it.effect("decodes only the authenticated local GET snapshot", () =>
  Effect.gen(function*() {
    const snapshot = resourcesFixture("live-healthy").snapshot
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.url).toBe("/v1/host/resources")
        expect(request.method).toBe("GET")
        expect(request.body._tag).toBe("Empty")
        return HttpClientResponse.fromWeb(request, Response.json(snapshot))
      })
    )
    expect(yield* loadHostResources().pipe(Effect.provideService(HttpClient.HttpClient, client))).toEqual(snapshot)
  }))
it.effect("classifies invalid payloads and status failures without copying their body", () =>
  Effect.gen(function*() {
    for (
      const [status, body, reason] of [[503, "private failure text", "status"], [200, "{}", "invalid_response"], [
        200,
        "{" + " ".repeat(4 * 1024 * 1024),
        "invalid_response"
      ]] satisfies ReadonlyArray<readonly [number, string, "status" | "invalid_response"]>
    ) {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
      )
      const failure = yield* loadHostResources().pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip)
      expect(failure.reason).toBe(reason)
      expect(JSON.stringify(failure)).not.toContain("private failure text")
    }
  }))
it.effect("probes only loopback status headers without following a redirect or sending a body", () =>
  Effect.gen(function*() {
    const urls: Array<string> = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url)
        expect(request.method).toBe("GET")
        expect(request.body._tag).toBe("Empty")
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 302, headers: { location: "https://remote.example.test/" } })
        )
      })
    )
    expect(yield* probePreview(client, 4791)).toBe("https")
    expect(urls).toEqual(["https://127.0.0.1:4791/"])
  }))
it.effect("bounds each protocol probe to two seconds before falling back", () =>
  Effect.gen(function*() {
    const urls: Array<string> = []
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        urls.push(request.url)
        return request.url.startsWith("https:")
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })))
      })
    )
    const fiber = yield* probePreview(client, 4791).pipe(Effect.forkScoped)
    yield* TestClock.adjust("2 seconds")
    expect(yield* Fiber.join(fiber)).toBe("http")
    expect(urls).toEqual(["https://127.0.0.1:4791/", "http://127.0.0.1:4791/"])
  }))
it("requires a DNS hostname before emitting a preview link", () => {
  for (
    const value of [
      "127.0.0.1",
      "localhost",
      "user@maple.example.test",
      "maple.example.test/path",
      "https://maple.example.test"
    ]
  ) expect(Schema.decodeUnknownResult(PreviewHostname)(value)._tag).toBe("Failure")
  expect(Schema.decodeUnknownResult(PreviewHostname)("maple.example.test")._tag).toBe("Success")
})
