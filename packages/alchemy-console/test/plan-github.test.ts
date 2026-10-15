import { expect, layer } from "@effect/vitest"
import { Context, Effect, Layer, Option, Redacted, Ref } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { githubLayer, PlanGithub } from "../src/server/plan/github.js"

const token = Redacted.make("fixture-private-token")
type ResponseHandler = (url: URL) => Response
interface CapturedRequest {
  readonly url: string
  readonly authorization: string | undefined
}
class GithubFixture extends Context.Service<GithubFixture, {
  readonly configure: (handler: ResponseHandler) => Effect.Effect<void>
  readonly requests: Ref.Ref<ReadonlyArray<CapturedRequest>>
}>()("AlchemyConsole/GithubFixture") {}
const transportLayer = Layer.effectContext(Effect.gen(function*() {
  const requests = yield* Ref.make<ReadonlyArray<CapturedRequest>>([])
  const handler = yield* Ref.make<Option.Option<ResponseHandler>>(Option.none())
  const transport = HttpClient.make((request, url, _signal, fiber) =>
    Effect.gen(function*() {
      expect(request.method).toBe("GET")
      expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)).toEqual({
        redirect: "manual",
        cache: "no-store"
      })
      yield* Ref.update(
        requests,
        (rows) => [...rows, { url: request.url, authorization: request.headers.authorization }]
      )
      const response = yield* Ref.get(handler)
      if (Option.isNone(response)) return yield* Effect.die("GitHub fixture is not configured")
      return HttpClientResponse.fromWeb(request, response.value(url))
    })
  )
  return Context.make(HttpClient.HttpClient, transport).pipe(Context.add(GithubFixture, {
    requests,
    configure: (response) => Ref.set(handler, Option.some(response)).pipe(Effect.andThen(Ref.set(requests, [])))
  }))
}))
const fixtures = githubLayer(token).pipe(Layer.provideMerge(transportLayer))
const useGithub = Effect.fn("GithubFixture.configure")(function*(response: ResponseHandler) {
  const fixture = yield* GithubFixture
  const service = yield* PlanGithub
  yield* fixture.configure(response)
  return { service, requests: fixture.requests }
})
layer(fixtures)("CI GitHub transport", (it) => {
  it.effect("reads latest main commit seen by CI using Actions only, including skipped runs and missing history", () =>
    Effect.gen(function*() {
      for (
        const rows of [[], [{
          head_sha: "a".repeat(40),
          head_branch: "main",
          event: "push",
          repository: { id: 1288997422 },
          head_repository: { id: 1288997422 },
          conclusion: "skipped"
        }]]
      ) {
        const { requests, service } = yield* useGithub((url) => {
          expect(url.pathname).toBe("/repos/knpkv/infra/actions/runs")
          expect(url.searchParams.get("branch")).toBe("main")
          expect(url.searchParams.get("event")).toBe("push")
          expect(url.searchParams.get("per_page")).toBe("1")
          return Response.json({ workflow_runs: rows })
        })
        expect(yield* service.latestMainSeenByCi()).toBe(rows[0]?.head_sha ?? null)
        expect((yield* Ref.get(requests)).every((request) => !request.url.includes("git/ref"))).toBe(true)
      }
    }))
  it.effect("follows one validated blob URL without forwarding the Actions token", () =>
    Effect.gen(function*() {
      const { requests, service } = yield* useGithub((url) =>
        url.host === "api.github.com"
          ? new Response(null, {
            status: 302,
            headers: { location: "https://fixture.blob.core.windows.net/plan?private=fixture-signed-token" }
          })
          : new Response("fixture archive")
      )
      expect(new TextDecoder().decode(yield* service.download(301))).toBe("fixture archive")
      const seen = yield* Ref.get(requests)
      expect(seen[0]?.authorization).toBe("Bearer fixture-private-token")
      expect(seen[1]?.authorization).toBeUndefined()
    }))
  for (
    const location of [
      "http://fixture.blob.core.windows.net/plan",
      "https://fixture.invalid/plan",
      "https://api.github.com/private",
      "https://user:password@fixture.blob.core.windows.net/plan"
    ]
  ) {
    it.effect(`refuses an unapproved download redirect ${new URL(location).hostname}`, () =>
      Effect.gen(function*() {
        const { requests, service } = yield* useGithub(() => new Response(null, { status: 302, headers: { location } }))
        const result = yield* Effect.result(service.download(301))
        expect(result._tag === "Failure" && result.failure._tag).toBe("PlanMetadataInvalid")
        expect((yield* Ref.get(requests)).length).toBe(1)
      }))
  }
  for (const status of [401, 403]) {
    it.effect(`classifies CI HTTP ${status} without retaining its body`, () =>
      Effect.gen(function*() {
        const { service } = yield* useGithub(() => new Response("fixture-private-value", { status }))
        const result = yield* Effect.result(service.workflow("infra.yml"))
        expect(result._tag === "Failure" && result.failure._tag).toBe("PlanCiRefused")
        expect(JSON.stringify(result)).not.toContain("fixture-private-value")
      }))
  }
  it.effect("caps streamed downloads and metadata bodies before buffering or decoding", () =>
    Effect.gen(function*() {
      const { service } = yield* useGithub((url) =>
        url.host === "api.github.com"
          ? new Response(null, { status: 302, headers: { location: "https://fixture.blob.core.windows.net/plan" } })
          : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(1_000_000))
                controller.close()
              }
            })
          )
      )
      const result = yield* Effect.result(service.download(301))
      expect(result._tag === "Failure" && result.failure._tag).toBe("PlanMetadataInvalid")
      const metadata = yield* useGithub(() => new Response("x".repeat(1_000_000)))
      const result2 = yield* Effect.result(metadata.service.workflow("infra.yml"))
      expect(result2._tag === "Failure" && result2.failure._tag).toBe("PlanMetadataInvalid")
    }))
  it.effect("rejects truncated pagination rather than treating unseen artifacts as absent", () =>
    Effect.gen(function*() {
      const { requests, service } = yield* useGithub(() =>
        Response.json({
          jobs: Array.from(
            { length: 100 },
            (_, i) => ({
              id: i + 1,
              name: "site / native",
              status: "completed",
              conclusion: "success",
              run_attempt: 1,
              steps: []
            })
          )
        })
      )
      const result = yield* Effect.result(service.jobs(100))
      expect(result._tag === "Failure" && result.failure._tag).toBe("PlanMetadataInvalid")
      expect((yield* Ref.get(requests)).length).toBe(10)
    }))

  it.effect("a dropped archive stream is Unreachable rather than an invalid receipt", () =>
    Effect.gen(function*() {
      const { service } = yield* useGithub((url) =>
        url.host === "api.github.com"
          ? new Response(null, { status: 302, headers: { location: "https://fixture.blob.core.windows.net/plan" } })
          : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError("fixture transport failure"))
              }
            })
          )
      )
      const result = yield* Effect.result(service.download(301))
      expect(result._tag === "Failure" && result.failure._tag).toBe("PlanCiUnreachable")
    }))
})
