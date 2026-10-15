import { expect, layer } from "@effect/vitest"
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { githubLayer, PlanGithub, Run } from "../src/server/plan/github.js"
import { producer } from "./planFixture.js"

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
  it.effect("classifies fixed repository and workflow discovery 404s as access refusals", () =>
    Effect.gen(function*() {
      const { service } = yield* useGithub(() => new Response("fixture-private-value", { status: 404 }))
      for (
        const request of [
          service.workflow("infra.yml").pipe(Effect.asVoid),
          service.runs("infra.yml").pipe(Effect.asVoid),
          service.artifacts("site").pipe(Effect.asVoid),
          service.latestMainSeenByCi().pipe(Effect.asVoid)
        ]
      ) {
        const result = yield* Effect.result(request)
        expect(result._tag === "Failure" && result.failure._tag).toBe("PlanCiRefused")
        expect(JSON.stringify(result)).not.toContain("fixture-private-value")
      }
    }))
  for (const status of [429, 500, 503]) {
    it.effect(`keeps discovery HTTP ${status} retryable`, () =>
      Effect.gen(function*() {
        const { service } = yield* useGithub(() => new Response(null, { status }))
        const result = yield* Effect.result(service.workflow("infra.yml"))
        expect(result._tag === "Failure" && result.failure._tag).toBe("PlanCiUnreachable")
      }))
  }
  it.effect("does not infer denied repository access from a missing individual run or artifact", () =>
    Effect.gen(function*() {
      const { service } = yield* useGithub(() => new Response(null, { status: 404 }))
      for (
        const request of [
          service.run(100).pipe(Effect.asVoid),
          service.jobs(100).pipe(Effect.asVoid),
          service.download(301).pipe(Effect.asVoid)
        ]
      ) {
        const result = yield* Effect.result(request)
        expect(result._tag === "Failure" && result.failure._tag).toBe("PlanCiUnreachable")
      }
    }))
  for (
    const sample of [
      {
        name: "primary rate limit headers",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792074000" },
        message: "fixture-private-value",
        expected: "PlanCiUnreachable"
      },
      {
        name: "secondary rate limit header",
        headers: { "retry-after": "60", "x-ratelimit-remaining": "17" },
        message: "fixture-private-value",
        expected: "PlanCiUnreachable"
      },
      {
        name: "primary rate limit message",
        headers: {},
        message: "API rate limit exceeded for fixture-private-value",
        expected: "PlanCiUnreachable"
      },
      {
        name: "secondary rate limit message",
        headers: {},
        message: "You have exceeded a secondary rate limit. fixture-private-value",
        expected: "PlanCiUnreachable"
      },
      {
        name: "authorization refusal with rate limit budget remaining",
        headers: { "x-ratelimit-remaining": "17", "x-ratelimit-reset": "1792074000" },
        message: "Resource not accessible by fixture-private-value",
        expected: "PlanCiRefused"
      }
    ]
  ) {
    it.effect(`classifies 403 ${sample.name} without emitting the error body`, () =>
      Effect.gen(function*() {
        const { service } = yield* useGithub(() =>
          Response.json({ message: sample.message }, { status: 403, headers: sample.headers })
        )
        const result = yield* Effect.result(service.workflow("infra.yml"))
        expect(result._tag === "Failure" && result.failure._tag).toBe(sample.expected)
        expect(JSON.stringify(result)).not.toContain("fixture-private-value")
      }))
  }
  it.effect("reads a full workflow page with realistic repository and commit envelopes", () =>
    Effect.gen(function*() {
      const runs = Array.from({ length: 100 }, (_, index) => ({
        ...Schema.encodeSync(Run)(producer),
        id: index + 1,
        repository: { ...producer.repository, description: "r".repeat(4096) },
        head_repository: { ...producer.head_repository, description: "h".repeat(4096) },
        head_commit: { message: "c".repeat(4096) }
      }))
      const { requests, service } = yield* useGithub((url) => {
        const pageSize = Number(url.searchParams.get("per_page"))
        const page = Number(url.searchParams.get("page"))
        return Response.json({ workflow_runs: runs.slice((page - 1) * pageSize, page * pageSize) })
      })
      expect((yield* service.runs("infra.yml")).map((run) => run.id)).toEqual(runs.map((run) => run.id))
      expect((yield* Ref.get(requests)).length).toBe(2)
    }))
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
      const metadata = yield* useGithub(() =>
        Response.json({
          id: 10,
          path: ".github/workflows/infra.yml",
          state: "active",
          description: "x".repeat(2 * 1024 * 1024)
        })
      )
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
