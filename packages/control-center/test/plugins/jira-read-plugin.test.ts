import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import { NormalizedIssueAttributes } from "../../src/domain/normalizedIssue.js"
import { MaximumPluginPayloadBytes } from "../../src/domain/plugins/bounds.js"
import {
  AuthorizedPluginActionV1,
  type PluginActionProposalV1,
  PluginActionReconciliationRequestV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import {
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginTimeoutFailure
} from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import {
  JiraReadPluginConfiguration,
  makeJiraReadPluginRuntimeFromProvider
} from "../../src/server/plugins/jira/JiraReadPlugin.js"
import {
  type JiraPageRequest,
  type JiraReadProvider,
  mapJiraReadProviderFailure
} from "../../src/server/plugins/jira/JiraReadProvider.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"

const configuration = {
  webBaseUrl: "https://acme.atlassian.net",
  siteId: "cloud-acme",
  projectId: "10",
  pageSize: 2,
  maximumPages: 3,
  operationTimeoutMillis: 5_000
}

const issueReference = (vendorImmutableId: string): ReadPluginEntityRequestV1 =>
  Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
    entityType: "jira.issue",
    vendorImmutableId
  })

const syncRequest = (checkpoint: string | null = null) =>
  Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "project-issues", checkpoint })

const issue = {
  id: "10042",
  key: "PAY-42",
  fields: {
    summary: "Protect payment retries",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Keep retry state durable. Read the " },
            {
              type: "text",
              text: "runbook",
              marks: [{ type: "link", attrs: { href: "https://wiki.example.test/runbook" } }]
            },
            { type: "text", text: " before rollout." }
          ]
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "# Incident notes [not a link](https://wiki.example.test)" }]
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance Criteria" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Retry survives restart." }] }]
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Timeout is covered." }] }]
            }
          ]
        },
        { type: "codeBlock", content: [{ type: "text", text: "retry();" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Notes" }] },
        { type: "paragraph", content: [{ type: "text", text: "Legacy retries are out of scope." }] }
      ]
    },
    environment: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Production and staging" }] }]
    },
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
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Ready for " },
          {
            type: "text",
            text: "review",
            marks: [{ type: "link", attrs: { href: "https://wiki.example.test/review-checklist" } }]
          },
          { type: "text", text: "." }
        ]
      }]
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
  getCurrentUser: Effect.succeed({
    accountId: "ari",
    displayName: "Ari Chen",
    active: true,
    timeZone: "UTC"
  }),
  getServerInfo: Effect.succeed({
    baseUrl: "https://acme.atlassian.net",
    serverTitle: "Acme Jira"
  }),
  getProject: () => Effect.succeed({ id: "10", key: "PAY", name: "Payments" }),
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
  searchProjectIssues: () => Effect.succeed({ issues: [], nextPageToken: null }),
  updateIssueDescription: () => Effect.void,
  addIssueComment: () => Effect.succeed("c42"),
  getIssueTransitions: () => Effect.succeed([{ id: "31", name: "Done", toStatusId: "4", toStatusName: "Done" }]),
  transitionIssue: () => Effect.void,
  ...overrides
})

const withConnection = <Value, Error>(
  provider: JiraReadProvider,
  use: Effect.Effect<Value, Error, AuthorizedPluginExecutor | PluginConnection>,
  configured: unknown = configuration
): Effect.Effect<Value, Error | PluginFailure> => {
  const runtime = makeJiraReadPluginRuntimeFromProvider(provider, configured, configuration.siteId)
  return use.pipe(
    Effect.provide(runtime.layer.pipe(Layer.provide(NodeCrypto.layer))),
    Effect.scoped
  )
}

const ExpectedAttributes = NormalizedIssueAttributes

const editDescriptionRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "edit-description",
  target: { entityType: "jira.issue", vendorImmutableId: issue.id },
  expectedRevision: issue.fields.updated,
  payload: {
    description: {
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Keep retry state durable across restarts." }]
      }]
    }
  },
  evidenceIds: ["jira-description-review"]
})

const addedCommentBody = {
  type: "doc",
  version: 1,
  content: [{
    type: "paragraph",
    content: [{ type: "text", text: "The restart scenario is verified." }]
  }]
} satisfies { readonly type: "doc"; readonly version: 1; readonly content: ReadonlyArray<Schema.Json> }

const addCommentRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "add-comment",
  target: { entityType: "jira.issue", vendorImmutableId: issue.id },
  expectedRevision: issue.fields.updated,
  payload: {
    body: addedCommentBody
  },
  evidenceIds: ["jira-comment-review"]
})

const transitionRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "transition",
  target: { entityType: "jira.issue", vendorImmutableId: issue.id },
  expectedRevision: issue.fields.updated,
  payload: { transitionId: "31" },
  evidenceIds: ["jira-transition-review"]
})

const authorizeProposal = (proposal: PluginActionProposalV1) =>
  Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
    proposal,
    idempotencyKey: "jira-governed-action-1",
    payloadDigest: proposal.payloadDigest,
    authorizationId: "jira-authorization-1",
    authorizedAt: proposal.proposedAt,
    expiresAt: DateTime.add(proposal.proposedAt, { minutes: 5 })
  })

describe("JiraReadPlugin", () => {
  it.effect("rejects Jira description edits without an atomic provider revision precondition", () =>
    Effect.gen(function*() {
      const issueReads = yield* Ref.make(0)
      const mutations = yield* Ref.make(0)
      const proposed = yield* withConnection(
        baseProvider({
          getIssue: () => Ref.update(issueReads, (count) => count + 1).pipe(Effect.as(Option.some(issue))),
          updateIssueDescription: () => Ref.update(mutations, (count) => count + 1)
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(editDescriptionRequest).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(proposed))
      if (Result.isFailure(proposed)) {
        assert.strictEqual(proposed.failure._tag, "PluginUnsupportedCapabilityFailure")
        if (proposed.failure._tag === "PluginUnsupportedCapabilityFailure") {
          assert.strictEqual(proposed.failure.diagnosticCode, "jira-action-kind-or-target-unsupported")
        }
      }
      assert.strictEqual(yield* Ref.get(issueReads), 0)
      assert.strictEqual(yield* Ref.get(mutations), 0)
    }))

  it.effect("accepts an equivalent Jira offset revision while blocking a later instant", () => {
    const providerRevision = "2026-07-17T09:30:00.000+0000"
    const offsetRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
      ...addCommentRequest,
      expectedRevision: providerRevision
    })
    return Effect.gen(function*() {
      const equivalent = yield* withConnection(
        baseProvider({
          getIssue: () =>
            Effect.succeed(Option.some({
              ...issue,
              fields: { ...issue.fields, updated: providerRevision }
            }))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(offsetRequest)
        })
      )
      assert.strictEqual(equivalent.request.expectedRevision, providerRevision)

      const later = yield* withConnection(
        baseProvider({
          getIssue: () =>
            Effect.succeed(Option.some({
              ...issue,
              fields: { ...issue.fields, updated: "2026-07-17T09:31:00.000+0000" }
            }))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(offsetRequest).pipe(Effect.result)
        })
      )
      assert.isTrue(Result.isFailure(later))
      if (Result.isFailure(later)) {
        assert.strictEqual(later.failure._tag, "PluginConflictFailure")
        if (later.failure._tag === "PluginConflictFailure") {
          assert.strictEqual(later.failure.diagnosticCode, "jira-issue-revision-changed")
        }
      }
    })
  })

  it.effect("proposes and executes a revision-bound Jira comment", () =>
    withConnection(
      baseProvider(),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const executor = yield* AuthorizedPluginExecutor
        const proposal = yield* connection.proposeAction(addCommentRequest)

        assert.deepStrictEqual(proposal.request.payload, {
          _tag: "add-comment",
          issueKey: issue.key,
          body: addedCommentBody
        })
        assert.strictEqual(proposal.summary, "Comment on Jira issue PAY-42")

        const dispatched = yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
        assert.strictEqual(dispatched._tag, "confirmed")
        if (dispatched._tag === "confirmed") {
          assert.strictEqual(dispatched.receipt.status, "succeeded")
          assert.strictEqual(dispatched.receipt.providerOperationId, "jira-comment:c42")
        }
      })
    ))

  it.effect("confirms an execute-time Jira inspection failure before mutation", () =>
    Effect.gen(function*() {
      const issueReads = yield* Ref.make(0)
      const mutations = yield* Ref.make(0)
      return yield* withConnection(
        baseProvider({
          getIssue: () =>
            Ref.getAndUpdate(issueReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count < 2
                  ? Effect.succeed(Option.some(issue))
                  : Effect.fail(new PluginTimeoutFailure({ operation: "jira-get-issue" }))
              )
            ),
          addIssueComment: () => Ref.update(mutations, (count) => count + 1).pipe(Effect.as("unexpected-comment"))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)

          assert.strictEqual((yield* executor.preflight(authorized))._tag, "ready")
          const dispatched = yield* executor.executeAuthorizedAction(authorized)

          assert.strictEqual(dispatched._tag, "confirmed")
          if (dispatched._tag === "confirmed") {
            assert.strictEqual(dispatched.receipt.status, "failed")
          }
          assert.strictEqual(yield* Ref.get(mutations), 0)
        })
      )
    }))

  it.effect("confirms an oversized Jira comment as failed without reconciliation", () =>
    withConnection(
      baseProvider({
        addIssueComment: () =>
          mapJiraReadProviderFailure("jira-add-comment", {
            response: { status: 413 }
          })
      }),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const executor = yield* AuthorizedPluginExecutor
        const proposal = yield* connection.proposeAction(addCommentRequest)
        const dispatched = yield* executor.executeAuthorizedAction(authorizeProposal(proposal))

        assert.strictEqual(dispatched._tag, "confirmed")
        if (dispatched._tag === "confirmed") {
          assert.strictEqual(dispatched.receipt.status, "failed")
          assert.match(dispatched.receipt.providerOperationId, /^jr:rejected:add-comment:/u)
        }
      })
    ))

  it.effect("reconciles a Jira comment after its created response is malformed", () =>
    Effect.gen(function*() {
      const applied = yield* Ref.make(false)
      return yield* withConnection(
        baseProvider({
          getComments: (_issueId, request) =>
            Ref.get(applied).pipe(
              Effect.map((isApplied) => ({
                comments: isApplied
                  ? [{
                    id: "c-malformed",
                    body: addedCommentBody,
                    properties: [{
                      key: "dev.knpkv.control-center.idempotency",
                      value: "jira-governed-action-1"
                    }]
                  }]
                  : [],
                startAt: request.startAt,
                maxResults: request.maxResults,
                total: isApplied ? 1 : 0
              }))
            ),
          addIssueComment: () =>
            Ref.set(applied, true).pipe(
              Effect.andThen(Effect.fail(
                new PluginMalformedResponseFailure({
                  operation: "jira-add-comment",
                  diagnosticCode: "jira-comment-response-invalid"
                })
              ))
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          assert.isTrue(Result.isFailure(dispatched))
          if (!Result.isFailure(dispatched) || dispatched.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected a reconcilable malformed Jira comment response")
          }

          const reconciled = yield* executor.reconcile(
            Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
              reconciliationKey: dispatched.failure.reconciliationKey,
              idempotencyKey: authorized.idempotencyKey,
              payloadDigest: authorized.payloadDigest,
              authorizedAction: authorized
            })
          )
          assert.strictEqual(reconciled._tag, "succeeded")
          if (reconciled._tag === "succeeded") {
            assert.strictEqual(reconciled.receipt.providerOperationId, "jira-comment:c-malformed")
          }
        })
      )
    }))

  it.effect("keeps a malformed Jira action pre-read as malformed", () =>
    withConnection(
      baseProvider({
        getIssue: () =>
          Effect.fail(
            new PluginMalformedResponseFailure({
              operation: "jira-get-issue",
              diagnosticCode: "jira-http-response-invalid"
            })
          )
      }),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const proposed = yield* connection.proposeAction(addCommentRequest).pipe(Effect.result)

        assert.isTrue(Result.isFailure(proposed))
        if (Result.isFailure(proposed)) {
          assert.strictEqual(proposed.failure._tag, "PluginMalformedResponseFailure")
        }
      })
    ))

  it.effect("reconciles a timed-out Jira comment by its durable provider property", () =>
    Effect.gen(function*() {
      const applied = yield* Ref.make(false)
      return yield* withConnection(
        baseProvider({
          getComments: (_issueId, request) =>
            Ref.get(applied).pipe(
              Effect.map((isApplied) => ({
                comments: isApplied
                  ? [{
                    id: "c99",
                    body: addedCommentBody,
                    properties: [{
                      key: "dev.knpkv.control-center.idempotency",
                      value: "jira-governed-action-1"
                    }]
                  }]
                  : [],
                startAt: request.startAt,
                maxResults: request.maxResults,
                total: isApplied ? 1 : 0
              }))
            ),
          addIssueComment: () =>
            Ref.set(applied, true).pipe(
              Effect.andThen(Effect.fail(new PluginTimeoutFailure({ operation: "jira-add-comment" })))
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          assert.isTrue(Result.isFailure(dispatched))
          if (!Result.isFailure(dispatched) || dispatched.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected a reconcilable Jira comment outcome")
          }

          const reconciled = yield* executor.reconcile(
            Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
              reconciliationKey: dispatched.failure.reconciliationKey,
              idempotencyKey: authorized.idempotencyKey,
              payloadDigest: authorized.payloadDigest,
              authorizedAction: authorized
            })
          )

          assert.strictEqual(reconciled._tag, "succeeded")
          if (reconciled._tag === "succeeded") {
            assert.strictEqual(reconciled.receipt.providerOperationId, "jira-comment:c99")
          }
        })
      )
    }))

  it.effect("searches newest Jira comments when reconciliation is page-bounded", () =>
    Effect.gen(function*() {
      const includeMatch = yield* Ref.make(true)
      const requests = yield* Ref.make<ReadonlyArray<JiraPageRequest>>([])
      const oldComment = { id: "c-old", body: "Older comment" }
      const matchingComment = {
        id: "c-new",
        body: addedCommentBody,
        properties: [{
          key: "dev.knpkv.control-center.idempotency",
          value: "jira-governed-action-1"
        }]
      }
      return yield* withConnection(
        baseProvider({
          getComments: (_issueId, request) =>
            Effect.gen(function*() {
              yield* Ref.update(requests, (current) => [...current, request])
              const newestFirst = (yield* Ref.get(includeMatch))
                ? [matchingComment, oldComment]
                : [oldComment]
              const ordered = request.order === "newest" ? newestFirst : [...newestFirst].reverse()
              return {
                comments: ordered.slice(request.startAt, request.startAt + request.maxResults),
                startAt: request.startAt,
                maxResults: request.maxResults,
                total: newestFirst.length
              }
            }),
          addIssueComment: () => Effect.fail(new PluginTimeoutFailure({ operation: "jira-add-comment" }))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (!Result.isFailure(dispatched) || dispatched.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected a reconcilable Jira comment outcome")
          }
          const request = Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })

          const matched = yield* executor.reconcile(request)
          assert.strictEqual(matched._tag, "succeeded")
          assert.deepStrictEqual(yield* Ref.get(requests), [{
            startAt: 0,
            maxResults: 1,
            order: "newest"
          }])

          yield* Ref.set(includeMatch, false)
          const unmatched = yield* executor.reconcile(request)
          assert.strictEqual(unmatched._tag, "pending")
        }),
        { ...configuration, maximumPages: 1, pageSize: 1 }
      )
    }))

  it.effect("preserves the newest Jira comment page when total history exceeds the page bound", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<JiraPageRequest>>([])
      const matchingComment = {
        id: "c-newest",
        body: addedCommentBody,
        properties: [{
          key: "dev.knpkv.control-center.idempotency",
          value: "jira-governed-action-1"
        }]
      }
      const newestFirst = [
        matchingComment,
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `c-old-${index}`,
          body: `Older comment ${index}`
        }))
      ]
      return yield* withConnection(
        baseProvider({
          getComments: (_issueId, request) =>
            Effect.gen(function*() {
              yield* Ref.update(requests, (current) => [...current, request])
              return {
                comments: newestFirst.slice(request.startAt, request.startAt + request.maxResults),
                startAt: request.startAt,
                maxResults: request.maxResults,
                total: newestFirst.length
              }
            }),
          addIssueComment: () => Effect.fail(new PluginTimeoutFailure({ operation: "jira-add-comment" }))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (!Result.isFailure(dispatched) || dispatched.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected a reconcilable Jira comment outcome")
          }

          const reconciled = yield* executor.reconcile(
            Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
              reconciliationKey: dispatched.failure.reconciliationKey,
              idempotencyKey: authorized.idempotencyKey,
              payloadDigest: authorized.payloadDigest,
              authorizedAction: authorized
            })
          )

          assert.strictEqual(reconciled._tag, "succeeded")
          assert.deepStrictEqual(yield* Ref.get(requests), [
            { startAt: 0, maxResults: 2, order: "newest" },
            { startAt: 2, maxResults: 2, order: "newest" },
            { startAt: 4, maxResults: 2, order: "newest" }
          ])
        })
      )
    }))

  it.effect("reconciles a Jira comment with its authorized key after the issue key changes", () =>
    Effect.gen(function*() {
      const issueReads = yield* Ref.make(0)
      const reconciledBody = yield* Ref.make<Schema.Json>(addedCommentBody)
      return yield* withConnection(
        baseProvider({
          getIssue: () =>
            Ref.getAndUpdate(issueReads, (count) => count + 1).pipe(
              Effect.map((count) => Option.some(count < 2 ? issue : { ...issue, key: "PAY-900" }))
            ),
          getComments: (_issueId, request) =>
            Ref.get(reconciledBody).pipe(
              Effect.map((body) => ({
                comments: [{
                  id: "c-renamed-key",
                  body,
                  properties: [{
                    key: "dev.knpkv.control-center.idempotency",
                    value: "jira-governed-action-1"
                  }]
                }],
                startAt: request.startAt,
                maxResults: request.maxResults,
                total: 1
              }))
            ),
          addIssueComment: () => Effect.fail(new PluginTimeoutFailure({ operation: "jira-add-comment" }))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(addCommentRequest)
          const authorized = authorizeProposal(proposal)
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (!Result.isFailure(dispatched) || dispatched.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected a reconcilable Jira comment outcome")
          }
          const request = Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })

          const renamed = yield* executor.reconcile(request)
          assert.strictEqual(renamed._tag, "succeeded")

          yield* Ref.set(reconciledBody, {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Changed body" }] }]
          })
          const changedBody = yield* executor.reconcile(request)
          assert.strictEqual(changedBody._tag, "pending")
        })
      )
    }))

  it.effect("proposes and executes an available Jira transition", () =>
    Effect.gen(function*() {
      const transitions = yield* Ref.make<ReadonlyArray<string>>([])
      return yield* withConnection(
        baseProvider({
          transitionIssue: (_issueId, transitionId) => Ref.update(transitions, (current) => [...current, transitionId])
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(transitionRequest)

          assert.deepStrictEqual(proposal.request.payload, {
            _tag: "transition",
            issueKey: issue.key,
            transitionId: "31",
            transitionName: "Done",
            toStatusId: "4",
            toStatusName: "Done"
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorizeProposal(proposal))
          assert.strictEqual(dispatched._tag, "confirmed")
          assert.deepStrictEqual(yield* Ref.get(transitions), ["31"])
        })
      )
    }))

  it.effect("rejects a Jira transition that already targets the current status", () =>
    withConnection(
      baseProvider({
        getIssueTransitions: () =>
          Effect.succeed([{ id: "31", name: "In Review", toStatusId: "3", toStatusName: "In Review" }])
      }),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const proposed = yield* connection.proposeAction(transitionRequest).pipe(Effect.result)

        assert.isTrue(Result.isFailure(proposed))
        if (Result.isFailure(proposed)) {
          assert.strictEqual(proposed.failure._tag, "PluginConflictFailure")
          if (proposed.failure._tag === "PluginConflictFailure") {
            assert.strictEqual(proposed.failure.diagnosticCode, "jira-transition-already-current")
          }
        }
      })
    ))

  it.effect("blocks preflight when the authorized Jira transition is no longer available", () =>
    Effect.gen(function*() {
      const transitionReads = yield* Ref.make(0)
      return yield* withConnection(
        baseProvider({
          getIssueTransitions: () =>
            Ref.getAndUpdate(transitionReads, (count) => count + 1).pipe(
              Effect.map((count) =>
                count === 0
                  ? [{ id: "31", name: "Done", toStatusId: "4", toStatusName: "Done" }]
                  : []
              )
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(transitionRequest)
          const preflight = yield* executor.preflight(authorizeProposal(proposal))

          assert.strictEqual(preflight._tag, "blocked")
          if (preflight._tag === "blocked") {
            assert.deepStrictEqual(preflight.reasons, [
              "Jira transition blocked: jira-transition-unavailable"
            ])
          }
        })
      )
    }))

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

  it.effect("discovers the authenticated user, verified Atlassian site, and selected Jira project separately", () =>
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
          providerImmutableId: "10",
          displayName: "Payments"
        })
      })
    ))

  it.effect("keeps API-token Jira usable without claiming an unverified shared site", () =>
    Effect.gen(function*() {
      const runtime = makeJiraReadPluginRuntimeFromProvider(baseProvider(), configuration)
      const discovery = yield* PluginConnection.pipe(
        Effect.flatMap((connection) => connection.discover),
        Effect.provide(runtime.layer.pipe(Layer.provide(NodeCrypto.layer))),
        Effect.scoped
      )
      assert.isNull(discovery.workspace)
      assert.deepStrictEqual(discovery.resource, {
        providerImmutableId: "10",
        displayName: "Payments"
      })
    }))

  it.effect("rejects a project lookup that does not confirm the configured immutable ID", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider({ getProject: () => Effect.succeed({ id: "20", key: "OPS", name: "Operations" }) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.discover))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-project-identity-mismatch")
        }
      }
    }))

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
      assert.strictEqual(
        attributes.description,
        [
          "Keep retry state durable\\. Read the [runbook](<https://wiki.example.test/runbook>) before rollout\\.",
          "\\# Incident notes \\[not a link\\]\\(https\\:\\/\\/wiki\\.example\\.test\\)",
          "## Acceptance Criteria",
          "- Retry survives restart\\.\n- Timeout is covered\\.",
          "```\nretry();\n```",
          "## Notes",
          "Legacy retries are out of scope\\."
        ].join("\n\n")
      )
      assert.strictEqual(
        attributes.acceptanceCriteria,
        "- Retry survives restart\\.\n- Timeout is covered\\.\n\n```\nretry();\n```"
      )
      assert.strictEqual(attributes.environment, "Production and staging")
      assert.strictEqual(attributes.status, "In Review")
      assert.strictEqual(attributes.comments?.length, 3)
      assert.strictEqual(
        attributes.comments?.[0]?.body,
        "Ready for [review](<https://wiki.example.test/review-checklist>)\\."
      )
      assert.strictEqual(attributes.comments?.[1]?.body, "Please cover the timeout path\\.")
      assert.strictEqual(attributes.history?.length, 2)
      assert.isFalse(attributes.commentsTruncated)
      assert.isFalse(attributes.historyTruncated)
      assert.deepStrictEqual(attributes.truncatedFields, [])
      assert.deepStrictEqual(yield* Ref.get(commentStarts), [0, 2])
      assert.deepStrictEqual(yield* Ref.get(historyStarts), [0])

      const sam = attributes.collaborators?.find(({ sourcePersonId }) => sourcePersonId === "sam")
      assert.deepStrictEqual(sam?.roles, ["change-author", "commenter", "creator", "reporter"])
      const ari = attributes.collaborators?.find(({ sourcePersonId }) => sourcePersonId === "ari")
      assert.strictEqual(ari?.avatarUrl, "https://avatar.example/ari.png")
    }))

  it.effect("uses a longer Markdown fence when Jira code contains triple backticks", () =>
    Effect.gen(function*() {
      const fencedCode = "before\n```\n# heading\n```\nafter"
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(Option.some({
            ...issue,
            fields: {
              ...issue.fields,
              description: {
                type: "doc",
                content: [{ type: "codeBlock", content: [{ type: "text", text: fencedCode }] }]
              }
            }
          }))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.strictEqual(attributes.description, `\`\`\`\`\n${fencedCode}\n\`\`\`\``)
    }))

  it.effect("preserves whitespace inside Jira code blocks while normalizing outer spacing", () =>
    Effect.gen(function*() {
      const code = "a\n\n\nb  \n"
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(Option.some({
            ...issue,
            fields: {
              ...issue.fields,
              description: {
                type: "doc",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Before" }] },
                  { type: "codeBlock", content: [{ type: "text", text: code }] },
                  { type: "paragraph", content: [{ type: "text", text: "After" }] }
                ]
              }
            }
          }))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.strictEqual(attributes.description, `Before\n\n\`\`\`\n${code}\`\`\`\n\nAfter`)
    }))

  it.effect("preserves safe Jira smart-link cards and omits unsafe card URLs", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(Option.some({
            ...issue,
            fields: {
              ...issue.fields,
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "Read " },
                      { type: "inlineCard", attrs: { url: "https://wiki.example.test/runbook" } },
                      { type: "inlineCard", attrs: { url: "javascript:alert(1)" } }
                    ]
                  },
                  { type: "blockCard", attrs: { data: { url: "https://jira.example.test/browse/PAY-42" } } }
                ]
              }
            }
          }))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.include(attributes.description ?? "", "](<https://wiki.example.test/runbook>)")
      assert.include(attributes.description ?? "", "](<https://jira.example.test/browse/PAY-42>)")
      assert.notInclude(attributes.description ?? "", "javascript")
    }))

  it.effect("preserves a Jira ADF hard break without adding one to plain text", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(Option.some({
            ...issue,
            fields: {
              ...issue.fields,
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "first" },
                      { type: "hardBreak" },
                      { type: "text", text: "second" }
                    ]
                  },
                  { type: "paragraph", content: [{ type: "text", text: "first second" }] }
                ]
              }
            }
          }))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.strictEqual(attributes.description, "first\\\nsecond\n\nfirst second")
    }))

  it.effect("preserves supported Jira ADF inline formatting marks", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(Option.some({
            ...issue,
            fields: {
              ...issue.fields,
              description: {
                type: "doc",
                content: [{
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Deploy " },
                    { type: "text", text: "now", marks: [{ type: "strong" }] },
                    { type: "text", text: " with " },
                    { type: "text", text: "retry()", marks: [{ type: "code" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "carefully", marks: [{ type: "em" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "later", marks: [{ type: "strike" }] }
                  ]
                }]
              }
            }
          }))
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected Jira issue to be found")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.strictEqual(attributes.description, "Deploy **now** with `retry()` *carefully* ~~later~~")
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
      assert.lengthOf(attributes.comments ?? [], comments.length)
      assert.lengthOf(attributes.history ?? [], extendedChangelogs.length)
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

  it.effect("retains the newest Jira activity in chronological order when normalized collections reach their cap", () =>
    Effect.gen(function*() {
      const ascendingComments = Array.from({ length: 201 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: `Comment ${String(index)}`,
        created: `2026-07-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${
          String(index % 24).padStart(2, "0")
        }:00:00.000Z`
      }))
      const ascendingChangelogs = Array.from({ length: 201 }, (_, index) => ({
        ...changelogs[0],
        id: `history-${String(index)}`,
        created: `2026-07-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${
          String(index % 24).padStart(2, "0")
        }:30:00.000Z`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Effect.succeed({
            comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: ascendingComments.length
          }),
        getChangelogs: (_issueId, request) =>
          Effect.succeed({
            values: ascendingChangelogs.slice(request.startAt, request.startAt + request.maxResults),
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: ascendingChangelogs.length
          })
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 5 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(
        attributes.comments?.map(({ sourceId }) => sourceId),
        Array.from({ length: 200 }, (_, index) => `comment-${String(index + 1)}`)
      )
      assert.deepStrictEqual(
        attributes.history?.map(({ sourceId }) => sourceId),
        Array.from({ length: 200 }, (_, index) => `history-${String(index + 1)}`)
      )
      assert.isTrue(attributes.commentsTruncated)
      assert.isTrue(attributes.historyTruncated)
    }))

  it.effect("spends the bounded page budget on the newest Jira comment tail when total exceeds the fetch window", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make<ReadonlyArray<number>>([])
      const ascendingComments = Array.from({ length: 300 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: `Comment ${String(index)}`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(starts, (current) => [...current, request.startAt]).pipe(
            Effect.as({
              comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults,
              total: ascendingComments.length
            })
          )
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 5 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(yield* Ref.get(starts), [0, 100, 150, 200, 250])
      assert.deepStrictEqual(
        attributes.comments?.map(({ sourceId }) => sourceId),
        Array.from({ length: 200 }, (_, index) => `comment-${String(index + 100)}`)
      )
      assert.strictEqual(attributes.commentTotal, 300)
      assert.isTrue(attributes.commentsTruncated)
    }))

  it.effect("counts discovery against four pages while retaining the newest Jira comment tail", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make<ReadonlyArray<number>>([])
      const ascendingComments = Array.from({ length: 300 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: `Comment ${String(index)}`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(starts, (current) => [...current, request.startAt]).pipe(
            Effect.as({
              comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults,
              total: ascendingComments.length
            })
          )
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 4 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(yield* Ref.get(starts), [0, 150, 200, 250])
      assert.deepStrictEqual(
        attributes.comments?.map(({ sourceId }) => sourceId),
        Array.from({ length: 150 }, (_, index) => `comment-${String(index + 150)}`)
      )
    }))

  it.effect("drops the discovery page at the tail-window equality boundary", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make<ReadonlyArray<number>>([])
      const ascendingComments = Array.from({ length: 250 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: `Comment ${String(index)}`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(starts, (current) => [...current, request.startAt]).pipe(
            Effect.as({
              comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults,
              total: ascendingComments.length
            })
          )
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 4 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(yield* Ref.get(starts), [0, 100, 150, 200])
      assert.deepStrictEqual(
        attributes.comments?.map(({ sourceId }) => sourceId),
        Array.from({ length: 150 }, (_, index) => `comment-${String(index + 100)}`)
      )
    }))

  it.effect("uses all four pages sequentially when the complete collection fits", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make<ReadonlyArray<number>>([])
      const ascendingComments = Array.from({ length: 200 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: `Comment ${String(index)}`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Ref.update(starts, (current) => [...current, request.startAt]).pipe(
            Effect.as({
              comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
              startAt: request.startAt,
              maxResults: request.maxResults,
              total: ascendingComments.length
            })
          )
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 4 }
      )
      if (result._tag !== "found") return assert.fail("expected a complete Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.deepStrictEqual(yield* Ref.get(starts), [0, 50, 100, 150])
      assert.deepStrictEqual(
        attributes.comments?.map(({ sourceId }) => sourceId),
        Array.from({ length: 200 }, (_, index) => `comment-${String(index)}`)
      )
      assert.isFalse(attributes.commentsTruncated)
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
      assert.isBelow(attributes.comments?.length ?? 0, largeComments.length)
      assert.isBelow(attributes.history?.length ?? 0, largeChangelogs.length)
      assert.isTrue(attributes.commentsTruncated)
      assert.isTrue(attributes.historyTruncated)
      assert.deepStrictEqual(attributes.truncatedFields, ["comments", "history"])
    }))

  it.effect("reports clipping of rich text and individual collection values", () =>
    Effect.gen(function*() {
      const clippedIssue = {
        ...issue,
        fields: {
          ...issue.fields,
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "d".repeat(20_000) }] },
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance Criteria" }] },
              { type: "paragraph", content: [{ type: "text", text: "a".repeat(20_000) }] }
            ]
          },
          labels: ["l".repeat(1_000)],
          components: [{ id: "7", name: "c".repeat(1_000) }],
          fixVersions: [{ id: "v1", name: "Version 1", releaseDate: "2".repeat(200) }],
          subtasks: [{ id: "s1", key: "PAY-43", fields: { summary: "s".repeat(1_000) } }]
        }
      }
      const provider = baseProvider({
        getIssue: () => Effect.succeed(Option.some(clippedIssue)),
        getComments: (_issueId, request) =>
          Effect.succeed({
            comments: [{ ...comments[0], body: "m".repeat(20_000) }],
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: 1
          }),
        getChangelogs: (_issueId, request) =>
          Effect.succeed({
            values: [
              {
                ...changelogs[0],
                items: [{ field: "f".repeat(300), fromString: "x".repeat(2_000), toString: "y".repeat(2_000) }]
              }
            ],
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: 1
          })
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042"))))
      )
      if (result._tag !== "found") return assert.fail("expected a clipped Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)
      assert.lengthOf(attributes.description ?? "", 16_000)
      assert.lengthOf(attributes.acceptanceCriteria ?? "", 16_000)
      assert.lengthOf(attributes.comments?.[0]?.body ?? "", 16_000)
      assert.isFalse(attributes.commentsTruncated)
      assert.isTrue(attributes.commentBodiesTruncated)
      assert.isTrue(attributes.truncatedFields?.includes("acceptanceCriteria"))
      assert.isTrue(attributes.truncatedFields?.includes("comments"))
      assert.isTrue(attributes.truncatedFields?.includes("components"))
      assert.isTrue(attributes.truncatedFields?.includes("description"))
      assert.isTrue(attributes.truncatedFields?.includes("fixVersions"))
      assert.isTrue(attributes.truncatedFields?.includes("history"))
      assert.isTrue(attributes.truncatedFields?.includes("labels"))
      assert.isTrue(attributes.truncatedFields?.includes("subtasks"))
    }))

  it.effect("does not report body clipping from an old comment omitted by the retained tail", () =>
    Effect.gen(function*() {
      const ascendingComments = Array.from({ length: 201 }, (_, index) => ({
        ...comments[0],
        id: `comment-${String(index)}`,
        body: index === 0 ? "x".repeat(20_000) : `Comment ${String(index)}`
      }))
      const provider = baseProvider({
        getComments: (_issueId, request) =>
          Effect.succeed({
            comments: ascendingComments.slice(request.startAt, request.startAt + request.maxResults),
            startAt: request.startAt,
            maxResults: request.maxResults,
            total: ascendingComments.length
          })
      })

      const result = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(issueReference("10042")))),
        { ...configuration, pageSize: 50, maximumPages: 5 }
      )
      if (result._tag !== "found") return assert.fail("expected a bounded Jira issue event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(result.event.attributes)

      assert.isTrue(attributes.commentsTruncated)
      assert.isFalse(attributes.commentBodiesTruncated)
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
          reporter: {
            ...oversizedUser("oversized-reporter", "r"),
            avatarUrls: { "48x48": "javascript:alert(1)" }
          },
          creator: oversizedUser("oversized-creator", "c"),
          labels: Array.from({ length: 200 }, (_, index) => `${index}${"l".repeat(32_000)}`),
          components: Array.from({ length: 100 }, (_, index) => ({
            id: `component-${index}`,
            name: `component-${index}-${"c".repeat(32_000)}`
          })),
          fixVersions: Array.from({ length: 100 }, (_, index) => ({
            id: `version-${index}`,
            name: `version-${index}-${"v".repeat(230)}`,
            released: false
          })),
          subtasks: Array.from({ length: 200 }, (_, index) => ({
            id: `subtask-${index}`,
            key: `PAY-${index + 100}`,
            fields: { summary: `Subtask ${index} ${"s".repeat(32_000)}` }
          }))
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
      assert.isAbove(attributes.truncatedFields?.length ?? 0, 0)
      assert.isTrue(attributes.truncatedFields?.includes("subtasks"))
      assert.lengthOf(attributes.subtasks ?? [], 200)
      assert.lengthOf(attributes.subtasks?.[0]?.summary ?? "", 500)
      assert.lengthOf(attributes.labels?.[0] ?? "", 255)
      assert.isTrue(attributes.collaborators?.every(({ avatarUrl }) => avatarUrl === null))
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

  it.effect("rejects an issue from outside the configured project before requesting child collections", () =>
    Effect.gen(function*() {
      const childCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getIssue: () =>
          Effect.succeed(
            Option.some({
              ...issue,
              fields: { ...issue.fields, project: { id: "20", key: "OPS", name: "Operations" } }
            })
          ),
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
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-issue-project-mismatch")
        }
      }
      assert.strictEqual(yield* Ref.get(childCalls), 0)
    }))

  it.effect("paginates one project with stable checkpoints and normalizes issues, people, releases, and evidence", () =>
    Effect.gen(function*() {
      const searches = yield* Ref.make<
        ReadonlyArray<{
          readonly projectId: string
          readonly nextPageToken: string | null
          readonly watermark: { readonly updatedAt: string; readonly issueKey: string | null } | null
        }>
      >([])
      const secondIssue = {
        ...issue,
        id: "10043",
        key: "PAY-43",
        fields: {
          ...issue.fields,
          summary: "Bound retry attempts",
          updated: "2026-07-17T09:31:00.000Z"
        }
      }
      const provider = baseProvider({
        searchProjectIssues: (request) =>
          Ref.update(searches, (current) => [...current, request]).pipe(
            Effect.as(
              request.watermark !== null
                ? { issues: [secondIssue], nextPageToken: null }
                : request.nextPageToken === null
                ? { issues: [issue], nextPageToken: "page-2" }
                : { issues: [secondIssue], nextPageToken: null }
            )
          )
      })
      const pages = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest()))),
          Effect.map((collectedPages) => [...collectedPages])
        )
      )

      assert.lengthOf(pages, 2)
      assert.isTrue(pages[0]?.hasMore)
      assert.isFalse(pages[1]?.hasMore)
      assert.include(pages[1]?.checkpointAfterPage ?? "", "PAY-43")
      assert.deepStrictEqual((yield* Ref.get(searches)).map(({ projectId }) => projectId), ["10", "10"])
      assert.deepStrictEqual(
        pages[0]?.events.flatMap((event) => event._tag === "UpsertEntity" ? [event.entityType] : []),
        ["jira.issue", "release"]
      )
      assert.sameMembers(
        pages[0]?.events.map(({ _tag }) => _tag) ?? [],
        [
          "UpsertEntity",
          "UpsertPerson",
          "UpsertPerson",
          "UpsertPerson",
          "AppendEvidence",
          "UpsertEntity",
          "AppendEvidence",
          "ProposeRelationship"
        ]
      )
      const releaseEventIds = pages.flatMap(({ events }) =>
        events.flatMap((event) =>
          event._tag === "UpsertEntity" && event.entityType === "release"
            ? [event.eventId]
            : []
        )
      )
      assert.lengthOf(releaseEventIds, 2)
      assert.notStrictEqual(releaseEventIds[0], releaseEventIds[1])

      const replay = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) =>
            Stream.runCollect(connection.sync(syncRequest(pages[1]?.checkpointAfterPage ?? null)))
          ),
          Effect.map((collectedPages) => [...collectedPages])
        )
      )
      assert.lengthOf(replay, 1)
      assert.deepStrictEqual(replay[0]?.events, [])
      assert.deepStrictEqual((yield* Ref.get(searches))[2]?.watermark, {
        updatedAt: "2026-07-17T09:31:00.000Z",
        issueKey: "PAY-43"
      })
    }))

  it.effect("compares resumed watermarks after normalizing equivalent Jira timestamp offsets", () =>
    Effect.gen(function*() {
      const laterIssueAtSameInstant = {
        ...issue,
        id: "10043",
        key: "PAY-43",
        fields: {
          ...issue.fields,
          summary: "Continue the same update batch",
          updated: "2026-07-17T09:30:00.000+0000"
        }
      }
      const provider = baseProvider({
        searchProjectIssues: () => Effect.succeed({ issues: [laterIssueAtSameInstant], nextPageToken: null })
      })
      const checkpoint = "{\"version\":1,\"updatedAt\":\"2026-07-17T09:30:00.000Z\",\"issueId\":\"10042\"}"

      const pages = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest(checkpoint))))
        )
      )

      assert.lengthOf(pages, 1)
      assert.isNotEmpty(pages[0]?.events ?? [])
      assert.include(pages[0]?.checkpointAfterPage ?? "", "PAY-43")
      assert.include(pages[0]?.checkpointAfterPage ?? "", "2026-07-17T09:30:00.000Z")
    }))

  it.effect("accepts provider-ordered ties whose immutable numeric IDs decrease", () =>
    Effect.gen(function*() {
      const firstIssue = {
        ...issue,
        id: "10000",
        key: "PAY-9",
        fields: { ...issue.fields, updated: "2026-07-17T09:30:00.000Z" }
      }
      const secondIssue = {
        ...issue,
        id: "9999",
        key: "PAY-10",
        fields: { ...issue.fields, updated: "2026-07-17T09:30:00.000Z" }
      }
      const provider = baseProvider({
        searchProjectIssues: () => Effect.succeed({ issues: [firstIssue, secondIssue], nextPageToken: null })
      })

      const pages = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest())))
        )
      )

      assert.lengthOf(pages, 2)
      assert.isTrue(
        pages[1]?.events.some(
          (event) => event._tag === "UpsertEntity" && event.vendorImmutableId === "9999"
        )
      )
    }))

  it.effect("searches incremental Jira pages in the authenticated user's time zone", () =>
    Effect.gen(function*() {
      const requestedTimeZones = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        getCurrentUser: Effect.succeed({
          accountId: "ari",
          displayName: "Ari Chen",
          active: true,
          timeZone: "America/Los_Angeles"
        }),
        searchProjectIssues: (request) =>
          Ref.update(requestedTimeZones, (timeZones) => [...timeZones, request.timeZone]).pipe(
            Effect.as({ issues: [], nextPageToken: null })
          )
      })

      yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest())))
        )
      )

      assert.deepStrictEqual(yield* Ref.get(requestedTimeZones), ["America/Los_Angeles"])
    }))

  it.effect("revisions mutable fix-version evidence identities with the Jira issue", () =>
    Effect.gen(function*() {
      const searchCalls = yield* Ref.make(0)
      const provider = baseProvider({
        searchProjectIssues: () =>
          Ref.getAndUpdate(searchCalls, (count) => count + 1).pipe(
            Effect.map((count) => ({
              issues: [{
                ...issue,
                fields: {
                  ...issue.fields,
                  updated: count === 0
                    ? "2026-07-17T09:30:00.000Z"
                    : "2026-07-17T09:31:00.000Z"
                }
              }],
              nextPageToken: null
            }))
          )
      })
      const readEvidenceId = PluginConnection.pipe(
        Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest()))),
        Effect.map((pages) =>
          pages.flatMap(({ events }) => events).find(
            (event) => event._tag === "AppendEvidence" && event.summary.startsWith("Jira fix version")
          )
        ),
        Effect.flatMap((event) =>
          event?._tag === "AppendEvidence"
            ? Effect.succeed(event.evidenceId)
            : Effect.die("expected Jira fix-version evidence")
        )
      )

      const firstEvidenceId = yield* withConnection(provider, readEvidenceId)
      const secondEvidenceId = yield* withConnection(provider, readEvidenceId)

      assert.notStrictEqual(firstEvidenceId, secondEvidenceId)
      assert.include(firstEvidenceId, "2026-07-17T09:30:00.000Z")
      assert.include(secondEvidenceId, "2026-07-17T09:31:00.000Z")
    }))

  it.effect("persists a provider cursor when skipped rows exhaust the invocation bound", () =>
    Effect.gen(function*() {
      const pageTokens = yield* Ref.make<ReadonlyArray<string | null>>([])
      const oldIssue = (id: string) => ({
        ...issue,
        id,
        key: `PAY-${id}`,
        fields: { ...issue.fields, updated: "2026-07-17T09:30:00.000Z" }
      })
      const newerIssue = oldIssue("10043")
      const provider = baseProvider({
        searchProjectIssues: (request) =>
          Ref.update(pageTokens, (tokens) => [...tokens, request.nextPageToken]).pipe(
            Effect.as(
              request.nextPageToken === null
                ? { issues: [oldIssue("10040"), oldIssue("10041")], nextPageToken: "page-2" }
                : { issues: [newerIssue], nextPageToken: null }
            )
          )
      })
      const checkpoint = JSON.stringify({
        version: 3,
        updatedAt: "2026-07-17T09:30:00.000Z",
        issueKey: "PAY-10042",
        queryUpdatedAt: "2026-07-17T09:30:00.000Z",
        queryIssueKey: "PAY-10042",
        nextPageToken: null,
        cursorExpiresAt: null
      })
      const configured = { ...configuration, maximumPages: 1, pageSize: 2 }
      const synchronize = (resumeFrom: string) =>
        withConnection(
          provider,
          PluginConnection.pipe(
            Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest(resumeFrom)))),
            Effect.map((pages) => [...pages])
          ),
          configured
        )

      const skipped = yield* synchronize(checkpoint)
      assert.lengthOf(skipped, 1)
      assert.deepStrictEqual(skipped[0]?.events, [])
      assert.isFalse(skipped[0]?.hasMore)
      assert.include(skipped[0]?.checkpointAfterPage ?? "", "page-2")

      const resumed = yield* synchronize(skipped[0]?.checkpointAfterPage ?? checkpoint)
      assert.isNotEmpty(resumed[0]?.events ?? [])
      assert.include(resumed[0]?.checkpointAfterPage ?? "", "PAY-10043")
      assert.deepStrictEqual(yield* Ref.get(pageTokens), [null, "page-2"])
    }))

  it.effect("migrates quiet legacy watermarks without inventing an issue key", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        searchProjectIssues: () => Effect.succeed({ issues: [], nextPageToken: null })
      })
      const legacyCheckpoints = [
        "{\"version\":1,\"updatedAt\":\"2026-07-17T09:30:00.000Z\",\"issueId\":\"10042\"}",
        "{\"version\":2,\"updatedAt\":\"2026-07-17T09:30:00.000Z\",\"issueId\":\"10042\",\"nextPageToken\":null}"
      ]

      for (const legacyCheckpoint of legacyCheckpoints) {
        const pages = yield* withConnection(
          provider,
          PluginConnection.pipe(
            Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest(legacyCheckpoint)))),
            Effect.map((collectedPages) => [...collectedPages])
          )
        )

        assert.lengthOf(pages, 1)
        assert.deepStrictEqual(pages[0]?.events, [])
        assert.isFalse(pages[0]?.hasMore)
        assert.include(pages[0]?.checkpointAfterPage ?? "", "2026-07-17T09:30:00.000Z")
        assert.include(pages[0]?.checkpointAfterPage ?? "", "\"issueKey\":null")
      }
    }))

  it.effect("binds a bounded provider cursor to its original query and drops it after expiry", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-19T10:00:00.000Z")))
      const searches = yield* Ref.make<
        ReadonlyArray<{
          readonly projectId: string
          readonly nextPageToken: string | null
          readonly watermark: { readonly updatedAt: string; readonly issueKey: string | null } | null
          readonly maxResults: number
          readonly timeZone: string
        }>
      >([])
      const nextIssue = {
        ...issue,
        id: "10043",
        key: "PAY-43",
        fields: { ...issue.fields, updated: "2026-07-17T09:31:00.000Z" }
      }
      const provider = baseProvider({
        searchProjectIssues: (request) =>
          Ref.update(searches, (current) => [...current, request]).pipe(
            Effect.as(
              request.nextPageToken === null && request.watermark === null
                ? { issues: [issue], nextPageToken: "page-2" }
                : { issues: [nextIssue], nextPageToken: null }
            )
          )
      })
      const configured = { ...configuration, maximumPages: 1, pageSize: 1 }
      const synchronize = (checkpoint: string | null) =>
        withConnection(
          provider,
          PluginConnection.pipe(
            Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest(checkpoint)))),
            Effect.map((pages) => [...pages])
          ),
          configured
        )

      const initial = yield* synchronize(null)
      const boundedCheckpoint = initial[0]?.checkpointAfterPage ?? null
      assert.isNotNull(boundedCheckpoint)
      assert.isFalse(initial[0]?.hasMore)

      yield* synchronize(boundedCheckpoint)
      assert.deepStrictEqual((yield* Ref.get(searches))[1], {
        projectId: "10",
        watermark: null,
        nextPageToken: "page-2",
        maxResults: 1,
        timeZone: "UTC"
      })

      yield* TestClock.adjust("8 days")
      yield* synchronize(boundedCheckpoint)
      assert.deepStrictEqual((yield* Ref.get(searches))[2], {
        projectId: "10",
        watermark: {
          updatedAt: "2026-07-17T09:30:00.000Z",
          issueKey: "PAY-42"
        },
        nextPageToken: null,
        maxResults: 1,
        timeZone: "UTC"
      })

      yield* synchronize(
        "{\"version\":2,\"updatedAt\":\"2026-07-17T09:30:00.000Z\",\"issueId\":\"10042\",\"nextPageToken\":\"legacy-page-2\"}"
      )
      assert.deepStrictEqual((yield* Ref.get(searches))[3], {
        projectId: "10",
        watermark: {
          updatedAt: "2026-07-17T09:30:00.000Z",
          issueKey: null
        },
        nextPageToken: null,
        maxResults: 1,
        timeZone: "UTC"
      })
    }))

  it.effect("rejects a provider cursor echoed by a resumed Jira page", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-19T10:00:00.000Z")))
      const provider = baseProvider({
        searchProjectIssues: (request) =>
          Effect.succeed({
            issues: [
              request.nextPageToken === null
                ? issue
                : {
                  ...issue,
                  id: "10043",
                  key: "PAY-43",
                  fields: { ...issue.fields, updated: "2026-07-17T09:31:00.000Z" }
                }
            ],
            nextPageToken: "page-2"
          })
      })
      const configured = { ...configuration, maximumPages: 1, pageSize: 1 }
      const synchronize = (checkpoint: string | null) =>
        withConnection(
          provider,
          PluginConnection.pipe(
            Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest(checkpoint)))),
            Effect.map((pages) => [...pages])
          ),
          configured
        )

      const initial = yield* synchronize(null)
      const boundedCheckpoint = initial[0]?.checkpointAfterPage ?? null
      assert.isNotNull(boundedCheckpoint)
      const resumed = yield* synchronize(boundedCheckpoint).pipe(Effect.result)
      assert.isTrue(Result.isFailure(resumed))
      if (Result.isFailure(resumed)) {
        assert.strictEqual(resumed.failure._tag, "PluginMalformedResponseFailure")
        if (resumed.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(resumed.failure.diagnosticCode, "jira-sync-page-cursor-repeated")
        }
      }
    }))

  it.effect("rejects an invalid persisted watermark before searching Jira", () =>
    Effect.gen(function*() {
      const searchCalls = yield* Ref.make(0)
      const provider = baseProvider({
        searchProjectIssues: () =>
          Ref.update(searchCalls, (count) => count + 1).pipe(Effect.as({
            issues: [],
            nextPageToken: null
          }))
      })
      const outcome = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) =>
            Stream.runCollect(
              connection.sync(syncRequest("{\"version\":1,\"updatedAt\":\"not-a-date\",\"issueId\":\"10042\"}"))
            )
          )
        )
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
      }
      assert.strictEqual(yield* Ref.get(searchCalls), 0)
    }))

  it.effect("uses host time for observation while retaining a newer Jira update as the checkpoint revision", () =>
    Effect.gen(function*() {
      const observedAt = DateTime.makeUnsafe("2026-07-19T10:00:00.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const providerUpdatedAt = "2026-07-19T10:00:01.000Z"
      const provider = baseProvider({
        searchProjectIssues: () =>
          Effect.succeed({
            issues: [{
              ...issue,
              fields: { ...issue.fields, updated: providerUpdatedAt }
            }],
            nextPageToken: null
          })
      })

      const pages = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest())))
        )
      )
      const issueEvent = pages[0]?.events.find(
        (event) => event._tag === "UpsertEntity" && event.entityType === "jira.issue"
      )
      assert.strictEqual(issueEvent?._tag, "UpsertEntity")
      if (issueEvent?._tag !== "UpsertEntity") return yield* Effect.die("expected normalized Jira issue")
      assert.strictEqual(DateTime.formatIso(issueEvent.observedAt), "2026-07-19T10:00:00.000Z")
      assert.strictEqual(issueEvent.revision, providerUpdatedAt)
      assert.include(pages[0]?.checkpointAfterPage ?? "", providerUpdatedAt)
    }))

  it.effect("rejects a cross-project search result before reading comments or history", () =>
    Effect.gen(function*() {
      const childCalls = yield* Ref.make(0)
      const provider = baseProvider({
        searchProjectIssues: () =>
          Effect.succeed({
            issues: [{
              ...issue,
              fields: { ...issue.fields, project: { id: "20", key: "OPS", name: "Operations" } }
            }],
            nextPageToken: null
          }),
        getComments: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({})),
        getChangelogs: () => Ref.update(childCalls, (count) => count + 1).pipe(Effect.as({}))
      })
      const outcome = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runCollect(connection.sync(syncRequest())))
        )
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-sync-issue-project-mismatch")
        }
      }
      assert.strictEqual(yield* Ref.get(childCalls), 0)
    }))

  it.effect("interrupts an in-flight project search when synchronization is cancelled", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const provider = baseProvider({
        searchProjectIssues: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      })
      const runtime = makeJiraReadPluginRuntimeFromProvider(provider, configuration)
      const fiber = yield* PluginConnection.pipe(
        Effect.flatMap((connection) => Stream.runDrain(connection.sync(syncRequest()))),
        Effect.provide(runtime.layer.pipe(Layer.provide(NodeCrypto.layer))),
        Effect.scoped,
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
    }))

  it.live("fails a project search that exceeds its configured request timeout", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        searchProjectIssues: () => Effect.never
      })
      const outcome = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => Stream.runDrain(connection.sync(syncRequest())))
        ),
        { ...configuration, operationTimeoutMillis: 1_000 }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "PluginTimeoutFailure")
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
        Effect.provide(runtime.layer.pipe(Layer.provide(NodeCrypto.layer))),
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
