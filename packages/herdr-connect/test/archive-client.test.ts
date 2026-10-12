import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { loadConnectArchive } from "../src/archive-client.js"
import { appendArchivePage, archiveCountCopy, archivedAgentKey, archiveMatchesQuery } from "../src/archive-model.js"
import { ArchivedConnectAgent } from "../src/model.js"

const agent = Schema.decodeUnknownSync(ArchivedConnectAgent)({
  host: "fixture-host",
  agentId: "agent-review",
  name: "review-worker",
  kind: "reviewer",
  work: "package-work",
  state: "blocked",
  firstSeenAt: 1,
  closedAt: 20,
  lastWords: { text: "Not searched", createdAt: 19 }
})
const cursor = { host: agent.host, agentId: agent.agentId, closedAt: agent.closedAt }
const first = { agents: [agent], nextCursor: cursor }

/** Node has no browser origin; exercise the HTTP boundary with an explicit local test origin. */
const testClient = (
  respond: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) => HttpClient.make(respond).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost")))

describe("archive paging and search", () => {
  it("counts only loaded records and identifies a bounded archive", () => {
    expect(archiveCountCopy(first)).toBe("1+ closed agents in the last 90 days")
    expect(archiveCountCopy({ agents: [agent], nextCursor: null })).toBe("1 closed agent in the last 90 days")
  })
  it("retains separate closures and removes an exact repeated record", () => {
    const earlierClosure = { ...agent, closedAt: 10 }
    const next = appendArchivePage(first, { agents: [agent, earlierClosure], nextCursor: null })
    expect(next.agents).toEqual([agent, earlierClosure])
    expect(archivedAgentKey(agent)).not.toBe(archivedAgentKey(earlierClosure))
    expect(archivedAgentKey(agent)).not.toBe(archivedAgentKey({ ...agent, host: "another-host" }))
    expect(next.nextCursor).toBeNull()
  })
  it("searches name, host, kind and work, excluding state and last words", () => {
    for (const query of [" REVIEW-WORKER ", "fixture-host", "reviewer", "package-work", ""]) {
      expect(archiveMatchesQuery(agent, query)).toBe(true)
    }
    for (const query of ["blocked", "Not searched", "missing"]) expect(archiveMatchesQuery(agent, query)).toBe(false)
  })
})

describe("archive HTTP boundary", () => {
  it.effect("retains a typed transport failure for retry", () =>
    Effect.gen(function*() {
      const client = testClient((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: "offline" })
          })
        )
      )
      const error = yield* loadConnectArchive(null).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip
      )
      expect(error._tag).toBe("ConnectArchiveLoadError")
      expect(error.reason).toBe("network")
      expect(error.cause).toHaveProperty("reason._tag", "TransportError")
    }))
  it.effect("requests exactly one page with the opaque encoded cursor", () =>
    Effect.gen(function*() {
      const paths: Array<string> = []
      const client = testClient((request) => {
        paths.push(request.url)
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(first)))
      })
      expect(yield* loadConnectArchive(cursor).pipe(Effect.provideService(HttpClient.HttpClient, client))).toEqual(
        first
      )
      expect(paths).toEqual([
        `http://localhost/v1/connect/archive?cursor=${encodeURIComponent(JSON.stringify(cursor))}`
      ])
    }))
  it.effect("names status failures rather than returning an empty archive", () =>
    Effect.gen(function*() {
      const client = testClient((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })))
      )
      const error = yield* loadConnectArchive(null).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip
      )
      expect(error._tag).toBe("ConnectArchiveLoadError")
      expect(error.reason).toBe("status")
      expect(error.cause).toBe(503)
    }))
  for (
    const body of [{ agents: [{ name: "broken" }], nextCursor: null }, {
      agents: Array.from({ length: 65 }, () => agent),
      nextCursor: null
    }]
  ) {
    it.effect("rejects an invalid or oversized archive page", () =>
      Effect.gen(function*() {
        const client = testClient((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))))
        const error = yield* loadConnectArchive(null).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip
        )
        expect(error.reason).toBe("decode")
      }))
  }
})
