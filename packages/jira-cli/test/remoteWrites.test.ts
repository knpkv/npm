import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient, make } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { IssueService, layer as IssueServiceLayer, SiteUrl } from "../src/IssueService.js"
import { layer as VersionServiceLayer, VersionService } from "../src/VersionService.js"

/** One recorded outbound call, so a test can assert what actually went to Jira. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

const bodyJson = (request: HttpClientRequest.HttpClientRequest): unknown => {
  if (request.body._tag !== "Uint8Array") return undefined
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

const issueFields = {
  attachment: [],
  components: [],
  created: "2026-01-01T00:00:00.000Z",
  description: "",
  issuetype: { name: "Task" },
  status: { name: "Done" },
  summary: "Sample issue",
  updated: "2026-01-01T00:00:00.000Z"
}

/**
 * Route by method+path and record every call.
 *
 * `respond` returns the web `Response` for a request; anything it does not
 * recognise 404s, so an unexpected extra call fails loudly rather than being
 * absorbed by a permissive catch-all.
 */
const makeRecordingLayer = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const calls: Array<RecordedRequest> = []
  const httpClient = HttpClient.make((request) => {
    calls.push({ method: request.method, url: request.url, body: bodyJson(request) })
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)))
  })
  const api = make(httpClient, {
    baseUrl: "https://jira.test",
    auth: { type: "basic", email: "test@example.com", apiToken: Redacted.make("token") }
  })
  const layer = Layer.succeed(
    JiraApiClient,
    JiraApiClient.of({ ...api, uploadAttachment: () => Effect.die("unused Jira upload mock") })
  )
  return { calls, layer }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("IssueService.edit", () => {
  /**
   * The payload builder is unit-tested separately; what this covers is that the
   * body it builds actually reaches `PUT /issue/{key}` unaltered, rather than
   * being reshaped or dropped on the way through the generated client.
   */
  it.effect("sends the built payload to PUT /issue/{key} and re-reads the issue", () => {
    const { calls, layer } = makeRecordingLayer((request) =>
      request.method === "PUT"
        // Jira answers a default edit with 204 No Content.
        ? new Response(null, { status: 204 })
        : json({
          id: "10000",
          key: "PROJ-123",
          fields: { ...issueFields, fixVersions: [{ name: "OOB 100" }], labels: ["domain:oob"] },
          renderedFields: {}
        })
    )

    return Effect.gen(function*() {
      const service = yield* IssueService
      const issue = yield* service.edit("PROJ-123", {
        addFixVersions: ["OOB 100"],
        addLabels: ["domain:oob"]
      })

      const put = calls.find((call) => call.method === "PUT")
      expect(put?.url).toContain("/rest/api/3/issue/PROJ-123")
      expect(put?.body).toEqual({
        update: {
          fixVersions: [{ add: { name: "OOB 100" } }],
          labels: [{ add: "domain:oob" }]
        }
      })

      // The 204 carries no body, so the reported state has to come from a re-read.
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(1)
      expect(issue.fixVersions).toEqual(["OOB 100"])
      expect(issue.labels).toEqual(["domain:oob"])
    }).pipe(
      Effect.provide(IssueServiceLayer),
      Effect.provide(layer),
      Effect.provide(Layer.succeed(SiteUrl, "https://example.atlassian.net"))
    )
  })

  /** A refused combination must never reach the network. */
  it.effect("fails before calling Jira when the flags contradict each other", () => {
    const { calls, layer } = makeRecordingLayer(() => new Response(null, { status: 204 }))

    return Effect.gen(function*() {
      const service = yield* IssueService
      const result = yield* Effect.flip(
        service.edit("PROJ-123", { setFixVersions: ["OOB 100"], addFixVersions: ["OOB 99"] })
      )

      expect(result.message).toContain("--fix-version cannot be combined")
      expect(calls).toHaveLength(0)
    }).pipe(
      Effect.provide(IssueServiceLayer),
      Effect.provide(layer),
      Effect.provide(Layer.succeed(SiteUrl, "https://example.atlassian.net"))
    )
  })
})

describe("VersionService.createVersion", () => {
  /**
   * The create endpoint wants a numeric `projectId`, but `/project/{key}`
   * serialises the id as a string — so the coercion is the whole reason the
   * project lookup exists, and sending the string form is a 400 from Jira.
   */
  it.effect("resolves the project key to a numeric projectId", () => {
    const { calls, layer } = makeRecordingLayer((request) =>
      request.url.includes("/rest/api/3/project/")
        ? json({ id: "10001", key: "PROJ" })
        : json({ id: "10042", name: "OOB 100", released: false, archived: false }, 201)
    )

    return Effect.gen(function*() {
      const service = yield* VersionService
      const version = yield* service.createVersion({
        projectKey: "PROJ",
        name: "OOB 100",
        description: "Q3 release"
      })

      const post = calls.find((call) => call.method === "POST")
      expect(post?.url).toContain("/rest/api/3/version")
      expect(post?.body).toEqual({ name: "OOB 100", projectId: 10001, description: "Q3 release" })
      expect(version.id).toBe("10042")
      expect(version.released).toBe(false)
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(layer))
  })

  /** Omitted optional fields must be absent, not sent as `undefined`/null. */
  it.effect("omits the optional date and description fields when not given", () => {
    const { calls, layer } = makeRecordingLayer((request) =>
      request.url.includes("/rest/api/3/project/")
        ? json({ id: "10001", key: "PROJ" })
        : json({ id: "10042", name: "OOB 100", released: false, archived: false }, 201)
    )

    return Effect.gen(function*() {
      const service = yield* VersionService
      yield* service.createVersion({ projectKey: "PROJ", name: "OOB 100" })

      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        name: "OOB 100",
        projectId: 10001
      })
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(layer))
  })

  /**
   * Without a usable id there is nothing to create the version against, and
   * Jira's own error for a missing projectId does not say so.
   */
  it.effect("fails with a named error when the project returns no numeric id", () => {
    const { calls, layer } = makeRecordingLayer(() => json({ key: "PROJ" }))

    return Effect.gen(function*() {
      const service = yield* VersionService
      const error = yield* Effect.flip(service.createVersion({ projectKey: "PROJ", name: "OOB 100" }))

      expect(error.message).toContain("no usable numeric id")
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(layer))
  })
})
