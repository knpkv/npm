import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { MaximumPluginPayloadBytes } from "../../src/domain/plugins/bounds.js"
import { ReadPluginEntityRequestV1 } from "../../src/domain/plugins/index.js"
import type { PluginFailure } from "../../src/server/plugins/failures.js"
import {
  JiraReadPluginConfiguration,
  makeJiraReadPluginRuntimeFromProvider
} from "../../src/server/plugins/jira/JiraReadPlugin.js"
import type { JiraPageRequest, JiraReadProvider } from "../../src/server/plugins/jira/JiraReadProvider.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"

const configuration = {
  webBaseUrl: "https://acme.atlassian.net",
  siteId: "cloud-acme",
  pageSize: 2,
  maximumPages: 3,
  operationTimeoutMillis: 5_000
}

const issueReference = (vendorImmutableId: string): ReadPluginEntityRequestV1 =>
  Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
    entityType: "jira.issue",
    vendorImmutableId
  })

const issue = {
  id: "10042",
  key: "PAY-42",
  fields: {
    summary: "Protect payment retries",
    description: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Keep retry state durable." }] }]
    },
    environment: null,
    status: { id: "3", name: "In Review" },
    priority: { id: "2", name: "High" },
    issuetype: { id: "10001", name: "Story" },
    project: { id: "10", key: "PAY", name: "Payments" },
    assignee: {
      accountId: "ari",
      displayName: "Ari Chen",
      active: true,
      avatarUrls: { "48x48": "https://avatar.example/ari.png" }
    },
    reporter: {
      accountId: "sam",
      displayName: "Sam Rivera",
      active: true,
      avatarUrls: { "48x48": "https://avatar.example/sam.png" }
    },
    creator: {
      accountId: "sam",
      displayName: "Sam Rivera",
      active: true
    },
    labels: ["release-candidate", "payments"],
    components: [{ id: "7", name: "Checkout" }],
    fixVersions: [{ id: "2026.29", name: "2026.29", released: false }],
    resolution: null,
    created: "2026-07-15T08:00:00.000Z",
    updated: "2026-07-17T09:30:00.000Z",
    duedate: "2026-07-21",
    resolutiondate: null,
    parent: { id: "10000", key: "PAY-1", fields: { summary: "Payments hardening" } },
    subtasks: []
  }
}

const comments = [
  {
    id: "c1",
    author: { accountId: "sam", displayName: "Sam Rivera", active: true },
    body: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Ready for review." }] }]
    },
    created: "2026-07-16T10:00:00.000Z",
    updated: "2026-07-16T10:00:00.000Z"
  },
  {
    id: "c2",
    author: { accountId: "lee", displayName: "Lee Okafor", active: true },
    body: "Please cover the timeout path.",
    created: "2026-07-16T11:00:00.000Z"
  },
  {
    id: "c3",
    author: { accountId: "ari", displayName: "Ari Chen", active: true },
    body: "Added the missing case.",
    created: "2026-07-17T09:00:00.000Z"
  }
]

const changelogs = [
  {
    id: "h1",
    author: { accountId: "sam", displayName: "Sam Rivera", active: true },
    created: "2026-07-16T09:00:00.000Z",
    items: [{ field: "status", fromString: "In Progress", toString: "In Review" }]
  },
  {
    id: "h2",
    author: { accountId: "ari", displayName: "Ari Chen", active: true },
    created: "2026-07-17T09:30:00.000Z",
    items: [{ field: "labels", fromString: "payments", toString: "payments release-candidate" }]
  }
]

const baseProvider = (overrides: Partial<JiraReadProvider> = {}): JiraReadProvider => ({
  getCurrentUser: Effect.succeed({ accountId: "ari", displayName: "Ari Chen", active: true }),
  getServerInfo: Effect.succeed({
    baseUrl: "https://acme.atlassian.net",
    serverTitle: "Acme Jira"
  }),
  getIssue: () => Effect.succeed(Option.some(issue)),
  getComments: (_issueId, request) =>
    Effect.succeed({
      comments: request.startAt === 0 ? comments.slice(0, 2) : comments.slice(2),
      startAt: request.startAt,
      maxResults: request.maxResults,
      total: comments.length
    }),
  getChangelogs: (_issueId, request) =>
    Effect.succeed({
      values: request.startAt === 0 ? changelogs : [],
      startAt: request.startAt,
      maxResults: request.maxResults,
      total: changelogs.length
    }),
  ...overrides
})

const withConnection = <Value, Error>(
  provider: JiraReadProvider,
  use: Effect.Effect<Value, Error, PluginConnection>,
  configured: unknown = configuration
): Effect.Effect<Value, Error | PluginFailure> => {
  const runtime = makeJiraReadPluginRuntimeFromProvider(provider, configured)
  return use.pipe(Effect.provide(runtime.layer), Effect.scoped)
}

const ExpectedAttributes = Schema.Struct({
  key: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Struct({ id: Schema.NullOr(Schema.String), name: Schema.NullOr(Schema.String) })),
  assigneeId: Schema.NullOr(Schema.String),
  reporterId: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  truncatedFields: Schema.Array(Schema.String),
  comments: Schema.Array(Schema.Struct({
    id: Schema.String,
    authorId: Schema.NullOr(Schema.String),
    body: Schema.NullOr(Schema.String)
  })),
  commentTotal: Schema.Number,
  commentsTruncated: Schema.Boolean,
  history: Schema.Array(Schema.Struct({
    id: Schema.String,
    authorId: Schema.NullOr(Schema.String)
  })),
  historyTotal: Schema.Number,
  historyTruncated: Schema.Boolean,
  collaborators: Schema.Array(Schema.Struct({
    providerPersonId: Schema.String,
    displayName: Schema.String,
    avatarUrl: Schema.NullOr(Schema.String),
    roles: Schema.Array(Schema.String)
  }))
})

describe("JiraReadPlugin", () => {
  it("accepts only HTTPS Jira Cloud tenant root URLs", () => {
    const decode = Schema.decodeUnknownResult(JiraReadPluginConfiguration)
    const configured = (webBaseUrl: string) => ({ ...configuration, webBaseUrl })

    assert.isTrue(Result.isSuccess(decode(configured("https://acme.atlassian.net"))))
    for (
      const invalid of [
        "http://acme.atlassian.net",
        "https://localhost",
        "https://collector.example",
        "https://atlassian.net.evil.example",
        "https://user:token@acme.atlassian.net",
        "https://acme.atlassian.net:8443",
        "https://acme.atlassian.net/path",
        "https://acme.atlassian.net?next=collector"
      ]
    ) {
      assert.isTrue(Result.isFailure(decode(configured(invalid))), invalid)
    }
  })

  it.effect("discovers the authenticated user, selected Atlassian site, and Jira surface separately", () =>
    withConnection(
      baseProvider(),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const discovery = yield* connection.discover

        assert.deepStrictEqual(discovery.account, {
          providerImmutableId: "ari",
          displayName: "Ari Chen"
        })
        assert.deepStrictEqual(discovery.workspace, {
          providerImmutableId: "cloud-acme",
          displayName: "Acme Jira"
        })
        assert.deepStrictEqual(discovery.resource, {
          providerImmutableId: "cloud-acme",
          displayName: "Jira"
        })
      })
    ))

  it.effect("reads all bounded activity pages and normalizes human issue context", () =>
    Effect.gen(function*() {
      const commentStarts = yield* Ref.make<ReadonlyArray<number>>([])
      const historyStarts = yield* Ref.make<ReadonlyArray<number>>([])
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(
            commentStarts,
            (starts) => [...starts, request.startAt]
          ).pipe(Effect.andThen(baseProvider().getComments("10042", request))),
        getChangelogs: (_issueId, request) =>
          Ref.update(
            historyStarts,
            (starts) => [...starts, request.startAt]
          ).pipe(Effect.andThen(baseProvider().getChangelogs("10042", request)))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))
        )
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.strictEqual(result.event.vendorImmutableId, "10042")
      assert.strictEqual(result.event.title, "PAY-42 · Protect payment retries")
      assert.strictEqual(result.event.sourceUrl?.href, "https://acme.atlassian.net/browse/PAY-42")
      assert.strictEqual(attributes.description, "Keep retry state durable.")
      assert.deepStrictEqual(attributes.status, { id: "3", name: "In Review" })
      assert.strictEqual(attributes.comments.length, 3)
      assert.strictEqual(attributes.comments[1]?.body, "Please cover the timeout path.")
      assert.strictEqual(attributes.history.length, 2)
      assert.isFalse(attributes.commentsTruncated)
      assert.isFalse(attributes.historyTruncated)
      assert.deepStrictEqual(attributes.truncatedFields, [])
      assert.deepStrictEqual(yield* Ref.get(commentStarts), [0, 2])
      assert.deepStrictEqual(yield* Ref.get(historyStarts), [0])

      const sam = attributes.collaborators.find(({ providerPersonId }) => providerPersonId === "sam")
      assert.deepStrictEqual(sam?.roles, ["change-author", "commenter", "creator", "reporter"])
      const ari = attributes.collaborators.find(({ providerPersonId }) => providerPersonId === "ari")
      assert.strictEqual(ari?.avatarUrl, "https://avatar.example/ari.png")
    }))

  it.effect("continues full comment and changelog pages when Jira omits total", () =>
    Effect.gen(function*() {
      const commentStarts = yield* Ref.make<ReadonlyArray<number>>([])
      const historyStarts = yield* Ref.make<ReadonlyArray<number>>([])
      const extendedChangelogs = [
        ...changelogs,
        { ...changelogs[0], id: "h3", created: "2026-07-17T10:00:00.000Z" }
      ]
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(commentStarts, (starts) => [...starts, request.startAt]).pipe(
            Effect.as({
              comments: comments.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults
            })
          ),
        getChangelogs: (_issueId, request) =>
          Ref.update(historyStarts, (starts) => [...starts, request.startAt]).pipe(
            Effect.as({
              values: extendedChangelogs.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults
            })
          )
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(yield* Ref.get(commentStarts), [0, 2])
      assert.deepStrictEqual(yield* Ref.get(historyStarts), [0, 2])
      assert.strictEqual(attributes.commentTotal, comments.length)
      assert.strictEqual(attributes.historyTotal, extendedChangelogs.length)
      assert.lengthOf(attributes.comments, comments.length)
      assert.lengthOf(attributes.history, extendedChangelogs.length)
      assert.isFalse(attributes.commentsTruncated)
      assert.isFalse(attributes.historyTruncated)
    }))

  it.effect("stops at the configured page bound and reports truncation", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<JiraPageRequest>>([])
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as({ comments: comments.slice(0, 1), startAt: 0, maxResults: 1, total: 10 })
          )
      })
      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 1, maximumPages: 1 }
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)
      assert.lengthOf(yield* Ref.get(requests), 1)
      assert.strictEqual(attributes.commentTotal, 10)
      assert.isTrue(attributes.commentsTruncated)
    }))

  it.effect("trims combined comment and history activity to the normalized payload budget", () =>
    Effect.gen(function*() {
      const largeComments = Array.from({ length: 250 }, (_, index) => ({
        ...comments[0],
        id: `large-comment-${index}`,
        body: "c".repeat(4_000)
      }))
      const largeChangelogs = Array.from({ length: 250 }, (_, index) => ({
        ...changelogs[0],
        id: `large-history-${index}`,
        items: [{ field: "description", fromString: "f".repeat(1_000), toString: "t".repeat(1_000) }]
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Effect.succeed({
            comments: largeComments.slice(request.startAt, request.startAt + request.maxResults),
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: largeComments.length
          }),
        getChangelogs: (_issueId, request) =>
          Effect.succeed({
            values: largeChangelogs.slice(request.startAt, request.startAt + request.maxResults),
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: largeChangelogs.length
          })
      })
      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 5 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)
      assert.isBelow(new TextEncoder().encode(JSON.stringify(result.event.attributes)).byteLength, 262_145)
      assert.isBelow(attributes.comments.length, largeComments.length)
      assert.isBelow(attributes.history.length, largeChangelogs.length)
      assert.isTrue(attributes.commentsTruncated)
      assert.isTrue(attributes.historyTruncated)
      assert.deepStrictEqual(attributes.truncatedFields, [])
    }))

  it.effect("trims oversized fixed issue attributes with explicit field metadata", () =>
    Effect.gen(function*() {
      const oversizedUser = (accountId: string, marker: string) => ({
        accountId,
        active: true,
        avatarUrls: { "48x48": `https://avatar.example/${marker.repeat(100_000)}` },
        displayName: marker.repeat(32_768)
      })
      const oversizedIssue = {
        ...issue,
        fields: {
          ...issue.fields,
          assignee: oversizedUser("oversized-assignee", "a"),
          reporter: oversizedUser("oversized-reporter", "r"),
          creator: oversizedUser("oversized-creator", "c"),
          labels: Array.from({ length: 9 }, (_, index) => `${index}${"l".repeat(32_767)}`)
        }
      }
      const provider = baseProvider({
        getIssue: () => Effect.succeed(Option.some(oversizedIssue)),
        getComments: (_issueId, request) =>
          Effect.succeed({ comments: [], startAt: request.startAt, maxResults: request.maxResults, total: 0 }),
        getChangelogs: (_issueId, request) =>
          Effect.succeed({ values: [], startAt: request.startAt, maxResults: request.maxResults, total: 0 })
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.isAtMost(
        new TextEncoder().encode(JSON.stringify(result.event.attributes)).byteLength,
        MaximumPluginPayloadBytes
      )
      assert.deepStrictEqual(attributes.labels, [])
      assert.deepStrictEqual(attributes.truncatedFields, ["collaborators", "labels"])
      assert.isTrue(attributes.collaborators.every(({ avatarUrl }) => avatarUrl === null))
      assert.isTrue(
        attributes.collaborators.every(({ displayName, providerPersonId }) => displayName === providerPersonId)
      )
    }))

  it.effect("reports an inconsistent empty provider page as truncated", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Effect.succeed({
            comments: [],
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: 10
          })
      })
      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)
      assert.strictEqual(attributes.commentTotal, 10)
      assert.isTrue(attributes.commentsTruncated)
    }))

  it.effect("returns missing without requesting child collections", () =>
    Effect.gen(function*() {
      const childCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getIssue: () => Effect.succeed(Option.none()),
        getComments: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({})),
        getChangelogs: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({}))
      })
      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("404"))))
      )
      assert.strictEqual(result._tag, "missing")
      assert.strictEqual(yield* Ref.get(childCalls), 0)
    }))

  it.effect("rejects a provider issue that omits normalization-critical fields", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getIssue: () => Effect.succeed(Option.some({ id: "10042", key: "PAY-42", fields: {} }))
      })
      const outcome = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
      }
    }))

  it.effect("rejects an issue identity mismatch before requesting child collections", () =>
    Effect.gen(function*() {
      const childCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getIssue: () => Effect.succeed(Option.some({ ...issue, id: "different-id" })),
        getComments: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({})),
        getChangelogs: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({}))
      })
      const outcome = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
      }
      assert.strictEqual(yield* Ref.get(childCalls), 0)
    }))

  it.effect("interrupts an in-flight provider page when the scoped read is cancelled", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const provider = baseProvider({
        getComments: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never)
          )
      })
      const runtime = makeJiraReadPluginRuntimeFromProvider(provider, configuration)
      const fiber = yield* PluginConnection.pipe(
        Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))),
        Effect.provide(runtime.layer),
        Effect.scoped,
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
    }))
})
