import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import {
  AuthorizedPluginActionV1,
  MaximumPluginPayloadBytes,
  MaximumPluginSyncPageBytes,
  PluginActionReconciliationRequestV1,
  PluginCheckpointV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  ConfluencePageAdapterConfiguration,
  makeConfluencePageAdapter
} from "../../src/server/plugins/confluence/ConfluencePageAdapter.js"
import {
  ConfluencePageClientFailure,
  type ConfluencePageClientShape
} from "../../src/server/plugins/confluence/ConfluencePageClient.js"
import { confluencePagePluginDescriptor } from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { ConfluencePageAttributesV1 } from "../../src/server/plugins/confluence/ConfluencePageSchemas.js"
import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"

const PAGE_ID = "42"
const CREATED_AT = "2026-07-01T09:00:00.000Z"
const UPDATED_AT = "2026-07-17T10:30:00.000Z"

const currentPage = {
  id: PAGE_ID,
  status: "current",
  title: "Payments release runbook",
  spaceId: "space-payments",
  parentId: "page-parent",
  authorId: "account-author",
  ownerId: "account-owner",
  createdAt: CREATED_AT,
  version: {
    number: 3,
    createdAt: UPDATED_AT,
    message: "Approve rollout",
    minorEdit: false,
    authorId: "account-author"
  },
  body: {
    atlas_doc_format: {
      representation: "atlas_doc_format",
      value: JSON.stringify({ type: "doc", version: 1, content: [] })
    }
  },
  _links: { webui: `/wiki/spaces/PAY/pages/${PAGE_ID}` }
}

const configuration = Schema.decodeUnknownSync(ConfluencePageAdapterConfiguration)({
  siteBaseUrl: "https://acme.atlassian.net",
  siteId: "site-acme",
  spaceId: "space-payments",
  probePageId: PAGE_ID
})

const request = Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
  entityType: "confluence-page",
  vendorImmutableId: PAGE_ID
})

const syncRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
  streamKey: "pages",
  checkpoint: null
})

const actionRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "update-page",
  target: {
    entityType: "page",
    vendorImmutableId: PAGE_ID
  },
  expectedRevision: "3",
  payload: {
    markdown: "# Updated rollout\n",
    title: "Payments release runbook v2",
    versionMessage: "Publish the approved rollout"
  },
  evidenceIds: ["evidence-17"]
})

const createActionRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
  actionKind: "create-page",
  target: {
    entityType: "release-page",
    vendorImmutableId: "space-payments"
  },
  expectedRevision: "0",
  payload: {
    title: "Release notes 2026.08",
    markdown: "Release notes",
    parentId: "42"
  },
  evidenceIds: []
})

const authorize = (
  proposal: typeof AuthorizedPluginActionV1.Type["proposal"],
  idempotencyKey = "confluence-publication-17"
) =>
  Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
    proposal,
    idempotencyKey,
    payloadDigest: proposal.payloadDigest,
    authorizationId: "authorization-17",
    authorizedAt: Schema.decodeSync(UtcTimestamp)("2026-07-17T10:31:00.000Z"),
    expiresAt: Schema.decodeSync(UtcTimestamp)("2026-07-17T11:31:00.000Z")
  })

const reconciliationRequest = (
  authorized: typeof AuthorizedPluginActionV1.Type,
  reconciliationKey: string | null = "cfpg:v1:42:4"
) =>
  Schema.decodeUnknownSync(Schema.toType(PluginActionReconciliationRequestV1))({
    reconciliationKey,
    idempotencyKey: authorized.idempotencyKey,
    payloadDigest: authorized.payloadDigest,
    authorizedAction: authorized
  })

const converter = (
  markdown = "Runbook\n",
  onConvert: () => void = () => undefined
): MarkdownConverter["Service"] => ({
  adfToMarkdown: () =>
    Effect.sync(() => {
      onConvert()
      return markdown
    }),
  markdownToAdf: (value) =>
    Effect.succeed(JSON.stringify({
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: value }]
      }]
    }))
})

const defaultClient = (overrides: Partial<ConfluencePageClientShape> = {}): ConfluencePageClientShape => ({
  getCurrentUser: Effect.succeed({
    accountId: "account-current-user",
    displayName: "Avery Bell",
    accountStatus: "active"
  }),
  getSystemInfo: Effect.succeed({ cloudId: "site-acme", commitHash: "commit", siteTitle: "Acme" }),
  getPage: () => Effect.succeed(currentPage),
  getPageDraft: () =>
    Effect.fail(
      new ConfluencePageClientFailure({
        operation: "confluence-page-draft-read",
        reason: "not-found",
        retryAfterSeconds: null
      })
    ),
  getPageVersion: () => Effect.succeed(currentPage.version),
  updatePage: () => Effect.die("unused updatePage"),
  createPage: () => Effect.die("unused createPage"),
  getSpacePages: () => Effect.succeed({ results: [currentPage] }),
  getPageAttachments: () => Effect.succeed({ results: [] }),
  getPageWatchers: (_pageId, start) => Effect.succeed({ results: [], start, limit: 50, size: 0 }),
  getPageVersions: () => Effect.succeed({ results: [currentPage.version] }),
  getUsers: (accountIds) =>
    Effect.succeed({
      results: accountIds.map((accountId) => ({
        accountId,
        displayName: accountId.replace("account-", ""),
        accountStatus: "active",
        isExternalCollaborator: false
      }))
    }),
  ...overrides
})

const makeAdapter = Effect.fn("ConfluencePageAdapterTest.make")(function*(
  client: ConfluencePageClientShape,
  markdown?: string,
  onConvert?: () => void,
  configured: ConfluencePageAdapterConfiguration = configuration
) {
  const descriptor = yield* negotiatePluginDescriptorV1(confluencePagePluginDescriptor)
  const cryptoService = yield* Crypto.Crypto.pipe(Effect.provide(NodeServices.layer))
  return makeConfluencePageAdapter({
    client,
    configuration: configured,
    converter: converter(markdown, onConvert),
    cryptoService,
    descriptor
  })
})

const normalizedAttributes = (
  markdown: string,
  contributors: ReadonlyArray<unknown> = [
    {
      accountId: "account-author",
      displayName: "author",
      active: true,
      external: false,
      resolved: true,
      roles: ["author", "contributor"]
    },
    {
      accountId: "account-owner",
      displayName: "owner",
      active: true,
      external: false,
      resolved: true,
      roles: ["owner"]
    }
  ]
) => ({
  schemaVersion: 1,
  status: "current",
  spaceId: currentPage.spaceId,
  parentId: currentPage.parentId,
  createdAt: currentPage.createdAt,
  updatedAt: currentPage.version.createdAt,
  currentVersion: currentPage.version.number,
  content: { representation: "safe-markdown", markdown },
  versions: [{
    number: currentPage.version.number,
    createdAt: currentPage.version.createdAt,
    message: currentPage.version.message,
    minorEdit: currentPage.version.minorEdit,
    authorId: currentPage.version.authorId
  }],
  versionHistory: { complete: true, pagesFetched: 1 },
  contributors
})

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const isTaggedFailure = (
  value: unknown
): value is {
  readonly _tag: string
  readonly diagnosticCode?: string
  readonly operation?: string
} =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof value._tag === "string"

const expectFailureTag = <A>(
  exit: Exit.Exit<A, unknown>,
  expectedTag: string,
  diagnosticCode?: string
): void => {
  assert.isTrue(Exit.isFailure(exit))
  if (!Exit.isFailure(exit)) return
  const failure = Cause.findErrorOption(exit.cause)
  assert.isTrue(Option.isSome(failure))
  if (Option.isNone(failure)) return
  assert.isTrue(isTaggedFailure(failure.value))
  if (!isTaggedFailure(failure.value)) return
  assert.strictEqual(failure.value._tag, expectedTag)
  if (diagnosticCode !== undefined) {
    assert.strictEqual(failure.value.diagnosticCode, diagnosticCode)
  }
}

const expectConfigurationFailure = <A>(
  exit: Exit.Exit<A, unknown>,
  diagnosticCode: string
): void => {
  expectFailureTag(exit, "PluginConfigurationFailure", diagnosticCode)
}

describe("Confluence page adapter", () => {
  it.effect("publishes the frozen ADF payload and accepts a provider-normalized marker suffix", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const updates: Array<Parameters<ConfluencePageClientShape["updatePage"]>[1]> = []
      const client = defaultClient({
        getPageDraft: () =>
          Effect.succeed({
            id: PAGE_ID,
            status: "draft",
            title: currentPage.title,
            spaceId: currentPage.spaceId,
            parentId: currentPage.parentId,
            ownerId: currentPage.ownerId,
            body: currentPage.body
          }),
        updatePage: (_pageId, update) =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.tap(() => Effect.sync(() => updates.push(update))),
            Effect.as({
              ...currentPage,
              title: update.title,
              version: {
                ...currentPage.version,
                number: update.version,
                message: update.versionMessage.replace("Publish the approved rollout", "Publish")
              },
              body: {
                atlas_doc_format: {
                  representation: "atlas_doc_format",
                  value: update.adf
                }
              }
            })
          )
      })
      const adapter = yield* makeAdapter(client)
      const proposal = yield* adapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const preflight = yield* adapter.executor.preflight(authorized)
      const result = yield* adapter.executor.executeAuthorizedAction(authorized)

      assert.strictEqual(preflight._tag, "ready")
      if (preflight._tag === "ready") assert.strictEqual(preflight.checkedRevision, "3")
      assert.strictEqual(result._tag, "confirmed")
      if (result._tag === "confirmed") {
        assert.strictEqual(result.receipt.status, "succeeded")
        assert.strictEqual(result.receipt.providerOperationId, "confluence-page:42:v4")
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
      assert.strictEqual(updates[0]?.version, 4)
      assert.strictEqual(updates[0]?.title, "Payments release runbook v2")
      assert.match(updates[0]?.versionMessage ?? "", /^Control Center confluence-publication-17 [0-9a-f]{64} · /u)
      assert.deepStrictEqual(JSON.parse(updates[0]?.adf ?? "{}"), {
        content: [{
          content: [{ text: "# Updated rollout\n", type: "text" }],
          type: "paragraph"
        }],
        type: "doc",
        version: 1
      })
    }))

  it.effect("creates and reconciles an append-only release page without replaying an unknown outcome", () =>
    Effect.gen(function*() {
      const createCalls = yield* Ref.make(0)
      const createdPage = {
        ...currentPage,
        id: "43",
        title: "Release notes 2026.08",
        body: {
          atlas_doc_format: {
            representation: "atlas_doc_format",
            value: JSON.stringify({
              type: "doc",
              version: 1,
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Release notes" }]
              }]
            })
          }
        }
      }
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [] }),
        createPage: () =>
          Ref.update(createCalls, (count) => count + 1).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new ConfluencePageClientFailure({
                  operation: "confluence-page-create",
                  reason: "outage",
                  retryAfterSeconds: null
                })
              )
            )
          )
      }))
      const proposal = yield* adapter.connection.proposeAction(createActionRequest)
      const authorized = authorize(proposal, "confluence-release-publication-17")
      const preflight = yield* adapter.executor.preflight(authorized)
      assert.strictEqual(preflight._tag, "ready")
      const execution = yield* adapter.executor.executeAuthorizedAction(authorized).pipe(Effect.result)
      assert.isTrue(Result.isFailure(execution))
      if (Result.isFailure(execution)) assert.strictEqual(execution.failure._tag, "PluginUnknownOutcomeFailure")
      const canonicalPayload = Schema.decodeUnknownSync(Schema.Struct({ adf: Schema.String }))(
        authorized.proposal.request.payload
      )
      const reconciledPage = {
        ...createdPage,
        body: {
          atlas_doc_format: {
            representation: "atlas_doc_format",
            value: canonicalPayload.adf
          }
        }
      }
      const reconciliationAdapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [reconciledPage] })
      }))
      const reconciled = yield* reconciliationAdapter.executor.reconcile(reconciliationRequest(authorized, null))
      assert.strictEqual(reconciled._tag, "succeeded")
      assert.strictEqual(yield* Ref.get(createCalls), 1)
    }))

  it.effect("blocks duplicate append-only release page titles before creation", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [currentPage] })
      }))
      const proposal = yield* adapter.connection.proposeAction(
        Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
          ...createActionRequest,
          payload: {
            title: currentPage.title,
            markdown: "Release notes",
            parentId: "42"
          }
        })
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(proposal))
      if (Result.isFailure(proposal)) assert.strictEqual(proposal.failure._tag, "PluginConflictFailure")
    }))

  it.effect("keeps retryable publication failures in the typed failure channel", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const cases = [
        { reason: "authentication", expectedTag: "PluginAuthenticationFailure" },
        { reason: "rate-limit", expectedTag: "PluginRateLimitFailure" }
      ] satisfies ReadonlyArray<{
        readonly reason: "authentication" | "rate-limit"
        readonly expectedTag: string
      }>
      for (const { expectedTag, reason } of cases) {
        const adapter = yield* makeAdapter(defaultClient({
          updatePage: () =>
            Effect.fail(
              new ConfluencePageClientFailure({
                operation: "confluence-page-update",
                reason,
                retryAfterSeconds: reason === "rate-limit" ? 30 : null
              })
            )
        }))
        const exit = yield* adapter.executor.executeAuthorizedAction(authorized).pipe(Effect.exit)
        expectFailureTag(exit, expectedTag)
      }
    }))

  it.effect("records an invalid provider update as a confirmed rejection without reconciliation reads", () =>
    Effect.gen(function*() {
      const reconciliationReads = yield* Ref.make(0)
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const adapter = yield* makeAdapter(defaultClient({
        getPageVersion: () =>
          Ref.update(reconciliationReads, (count) => count + 1).pipe(Effect.as(currentPage.version)),
        updatePage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-update",
              reason: "invalid-request",
              retryAfterSeconds: null
            })
          )
      }))

      const dispatched = yield* adapter.executor.executeAuthorizedAction(authorize(proposal))

      assert.strictEqual(dispatched._tag, "confirmed")
      if (dispatched._tag === "confirmed") {
        assert.strictEqual(dispatched.receipt.status, "failed")
      }
      assert.strictEqual(yield* Ref.get(reconciliationReads), 0)
    }))

  it.effect("records a page removed before the execution safety read as a confirmed rejection", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-read",
              reason: "not-found",
              retryAfterSeconds: null
            })
          ),
        updatePage: () => Effect.die("a removed page must not reach the provider mutation")
      }))

      const dispatched = yield* adapter.executor.executeAuthorizedAction(authorize(proposal))

      assert.strictEqual(dispatched._tag, "confirmed")
      if (dispatched._tag === "confirmed") {
        assert.strictEqual(dispatched.receipt.status, "failed")
        assert.strictEqual(
          dispatched.receipt.safeSummary,
          "Confluence rejected the authorized page publication without applying it"
        )
      }
    }))

  it.effect("blocks a stale authorized revision before any provider mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            version: { ...currentPage.version, number: 4 }
          }),
        updatePage: () => Ref.update(mutationCalls, (count) => count + 1).pipe(Effect.as(currentPage))
      }))
      const preflight = yield* adapter.executor.preflight(authorize(proposal))

      assert.strictEqual(preflight._tag, "blocked")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("blocks publication while a page draft diverges from the published page", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const adapter = yield* makeAdapter(defaultClient({
        getPageDraft: () =>
          Effect.succeed({
            id: PAGE_ID,
            status: "draft",
            title: "Unpublished manual edit",
            spaceId: "space-payments",
            body: currentPage.body
          }),
        updatePage: () => Ref.update(mutationCalls, (count) => count + 1).pipe(Effect.as(currentPage))
      }))
      const authorized = authorize(proposal)

      const preflight = yield* adapter.executor.preflight(authorized)
      const dispatched = yield* adapter.executor.executeAuthorizedAction(authorized).pipe(Effect.exit)

      assert.strictEqual(preflight._tag, "blocked")
      expectFailureTag(dispatched, "PluginConflictFailure", "confluence-page-draft-present")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("blocks publication while only the page draft body diverges", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const adapter = yield* makeAdapter(defaultClient({
        getPageDraft: () =>
          Effect.succeed({
            id: PAGE_ID,
            status: "draft",
            title: currentPage.title,
            spaceId: "space-payments",
            parentId: currentPage.parentId,
            ownerId: currentPage.ownerId,
            body: {
              atlas_doc_format: {
                representation: "atlas_doc_format",
                value: "{\"content\":[{\"type\":\"paragraph\"}],\"type\":\"doc\",\"version\":1}"
              }
            }
          }),
        updatePage: () => Ref.update(mutationCalls, (count) => count + 1).pipe(Effect.as(currentPage))
      }))
      const authorized = authorize(proposal)

      const preflight = yield* adapter.executor.preflight(authorized)
      const dispatched = yield* adapter.executor.executeAuthorizedAction(authorized).pipe(Effect.exit)

      assert.strictEqual(preflight._tag, "blocked")
      expectFailureTag(dispatched, "PluginConflictFailure", "confluence-page-draft-present")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("blocks publication when only the draft parent or owner diverges", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)

      yield* Effect.forEach([
        { parentId: "different-parent", ownerId: currentPage.ownerId },
        { parentId: currentPage.parentId, ownerId: "different-owner" }
      ], ({ ownerId, parentId }) =>
        Effect.gen(function*() {
          const mutationCalls = yield* Ref.make(0)
          const adapter = yield* makeAdapter(defaultClient({
            getPageDraft: () =>
              Effect.succeed({
                id: PAGE_ID,
                status: "draft",
                title: currentPage.title,
                spaceId: currentPage.spaceId,
                parentId,
                ownerId,
                body: currentPage.body
              }),
            updatePage: () => Ref.update(mutationCalls, (count) => count + 1).pipe(Effect.as(currentPage))
          }))

          const preflight = yield* adapter.executor.preflight(authorized)
          const dispatched = yield* adapter.executor.executeAuthorizedAction(authorized).pipe(Effect.exit)

          assert.strictEqual(preflight._tag, "blocked")
          expectFailureTag(dispatched, "PluginConflictFailure", "confluence-page-draft-present")
          assert.strictEqual(yield* Ref.get(mutationCalls), 0)
        }))
    }))

  it.effect("rejects non-canonical revisions and reconciliation locators before provider reads", () =>
    Effect.gen(function*() {
      const providerReads = yield* Ref.make(0)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () => Ref.update(providerReads, (count) => count + 1).pipe(Effect.as(currentPage))
      }))
      const invalidProposal = yield* adapter.connection.proposeAction(
        Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
          ...Schema.encodeSync(ProposePluginActionRequestV1)(actionRequest),
          expectedRevision: "03"
        })
      ).pipe(Effect.exit)
      expectConfigurationFailure(invalidProposal, "confluence-action-revision-invalid")

      const invalidReconciliation = yield* adapter.executor.reconcile(
        Schema.decodeUnknownSync(PluginActionReconciliationRequestV1)({
          reconciliationKey: "cfpg:v1:42:04",
          idempotencyKey: "confluence-publication-17",
          payloadDigest: "a".repeat(64)
        })
      ).pipe(Effect.exit)
      expectConfigurationFailure(invalidReconciliation, "confluence-reconciliation-key-invalid")

      const aboveMaximumReconciliation = yield* adapter.executor.reconcile(
        Schema.decodeUnknownSync(PluginActionReconciliationRequestV1)({
          reconciliationKey: "cfpg:v1:42:2147483648",
          idempotencyKey: "confluence-publication-17",
          payloadDigest: "a".repeat(64)
        })
      ).pipe(Effect.exit)
      expectConfigurationFailure(aboveMaximumReconciliation, "confluence-reconciliation-key-invalid")
      assert.strictEqual(yield* Ref.get(providerReads), 0)
    }))

  it.effect("executes and reconciles the maximum Confluence target version", () =>
    Effect.gen(function*() {
      const expectedVersion = 2_147_483_646
      const targetVersion = 2_147_483_647
      const page = yield* Ref.make({
        ...currentPage,
        version: { ...currentPage.version, number: expectedVersion }
      })
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () => Ref.get(page),
        updatePage: (_pageId, update) => {
          const updated = {
            ...currentPage,
            title: update.title,
            version: {
              ...currentPage.version,
              number: update.version,
              message: update.versionMessage
            }
          }
          return Ref.set(page, updated).pipe(Effect.as(updated))
        }
      }))
      const boundaryRequest = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
        ...Schema.encodeSync(ProposePluginActionRequestV1)(actionRequest),
        expectedRevision: String(expectedVersion)
      })
      const proposal = yield* adapter.connection.proposeAction(boundaryRequest)
      const authorized = authorize(proposal)

      const dispatched = yield* adapter.executor.executeAuthorizedAction(authorized)
      const reconciled = yield* adapter.executor.reconcile(
        reconciliationRequest(authorized, `cfpg:v1:${PAGE_ID}:${targetVersion}`)
      )

      assert.strictEqual(dispatched._tag, "confirmed")
      if (dispatched._tag === "confirmed") assert.strictEqual(dispatched.receipt.status, "succeeded")
      assert.strictEqual(reconciled._tag, "succeeded")
    }))

  it.effect("reconciles an old ambiguous publication by exact version without replay or a bounded scan", () =>
    Effect.gen(function*() {
      const versionMarker = yield* Ref.make("")
      const exactVersionReads = yield* Ref.make(0)
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const ambiguousAdapter = yield* makeAdapter(defaultClient({
        updatePage: (_pageId, update) =>
          Ref.set(versionMarker, update.versionMessage).pipe(
            Effect.andThen(Effect.fail(
              new ConfluencePageClientFailure({
                operation: "confluence-page-update",
                reason: "timeout",
                retryAfterSeconds: null
              })
            ))
          )
      }))
      const dispatched = yield* ambiguousAdapter.executor.executeAuthorizedAction(authorized).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(dispatched))
      if (Exit.isFailure(dispatched)) {
        const failure = Cause.findErrorOption(dispatched.cause)
        assert.isTrue(Option.isSome(failure))
        if (Option.isSome(failure)) assert.strictEqual(failure.value._tag, "PluginUnknownOutcomeFailure")
      }

      const reconciliationReads = yield* Ref.make(0)
      const reconciliationAdapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Ref.update(reconciliationReads, (count) => count + 1).pipe(
            Effect.as({
              ...currentPage,
              version: { ...currentPage.version, number: 5, message: "Later publication" }
            })
          ),
        getPageVersion: (_pageId, version) =>
          Ref.update(exactVersionReads, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(versionMarker)),
            Effect.map((marker) => ({ ...currentPage.version, number: version, message: marker }))
          ),
        getPageVersions: () => Effect.die("reconciliation must not walk bounded history"),
        updatePage: () => Effect.die("reconciliation must not replay the mutation")
      }))
      const reconciled = yield* reconciliationAdapter.executor.reconcile(
        reconciliationRequest(authorized)
      )

      assert.strictEqual(reconciled._tag, "succeeded")
      assert.strictEqual(yield* Ref.get(reconciliationReads), 1)
      assert.strictEqual(yield* Ref.get(exactVersionReads), 1)
    }))

  it.effect("keeps reconciliation pending when exact-version absence is ambiguous", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            version: { ...currentPage.version, number: 5, message: "Later publication" }
          }),
        getPageVersion: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-version",
              reason: "not-found",
              retryAfterSeconds: null
            })
          ),
        getPageVersions: () => Effect.die("reconciliation must not walk bounded history"),
        updatePage: () => Effect.die("reconciliation must not replay the mutation")
      }))

      const reconciled = yield* adapter.executor.reconcile(
        reconciliationRequest(authorized)
      )

      assert.strictEqual(reconciled._tag, "pending")
    }))

  it.effect("keeps reconciliation pending when the current page becomes hidden", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-read",
              reason: "not-found",
              retryAfterSeconds: null
            })
          ),
        getPageVersion: () => Effect.die("hidden current page must remain pending without exact lookup")
      }))

      const reconciled = yield* adapter.executor.reconcile(reconciliationRequest(authorized))

      assert.strictEqual(reconciled._tag, "pending")
    }))

  it.effect("fails reconciliation when the exact revision belongs to another publication", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            version: { ...currentPage.version, number: 5, message: "Later publication" }
          }),
        getPageVersion: (_pageId, version) =>
          Effect.succeed({
            ...currentPage.version,
            number: version,
            message: "Different publication"
          }),
        getPageVersions: () => Effect.die("reconciliation must not walk bounded history"),
        updatePage: () => Effect.die("reconciliation must not replay the mutation")
      }))

      const reconciled = yield* adapter.executor.reconcile(
        reconciliationRequest(authorized)
      )

      assert.strictEqual(reconciled._tag, "failed")
    }))

  it.effect("loads the exact current version when its summary omits the publication marker", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const exactVersionReads = yield* Ref.make(0)
      const marker = `Control Center ${authorized.idempotencyKey} ${authorized.payloadDigest}`
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            version: {
              number: 4,
              createdAt: currentPage.version.createdAt,
              minorEdit: currentPage.version.minorEdit,
              authorId: currentPage.version.authorId
            }
          }),
        getPageVersion: (_pageId, version) =>
          Ref.update(exactVersionReads, (count) => count + 1).pipe(
            Effect.as({
              ...currentPage.version,
              number: version,
              message: marker
            })
          )
      }))

      const reconciled = yield* adapter.executor.reconcile(reconciliationRequest(authorized))

      assert.strictEqual(reconciled._tag, "succeeded")
      assert.strictEqual(yield* Ref.get(exactVersionReads), 1)
    }))

  it.effect("keeps reconciliation pending while both version reads omit the marker", () =>
    Effect.gen(function*() {
      const proposalAdapter = yield* makeAdapter(defaultClient())
      const proposal = yield* proposalAdapter.connection.proposeAction(actionRequest)
      const authorized = authorize(proposal)
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            version: {
              number: 4,
              createdAt: currentPage.version.createdAt,
              minorEdit: currentPage.version.minorEdit,
              authorId: currentPage.version.authorId
            }
          }),
        getPageVersion: (_pageId, version) =>
          Effect.succeed({
            number: version,
            createdAt: currentPage.version.createdAt,
            minorEdit: currentPage.version.minorEdit,
            authorId: currentPage.version.authorId
          })
      }))

      const reconciled = yield* adapter.executor.reconcile(reconciliationRequest(authorized))

      assert.strictEqual(reconciled._tag, "pending")
    }))

  it("accepts only HTTPS Confluence Cloud tenant root URLs", () => {
    const decode = Schema.decodeUnknownResult(ConfluencePageAdapterConfiguration)
    const configured = (siteBaseUrl: string) => ({
      siteBaseUrl,
      siteId: "site-acme",
      spaceId: "space-payments",
      probePageId: PAGE_ID
    })

    assert.isTrue(Result.isSuccess(decode(configured("https://acme.atlassian.net"))))
    for (
      const invalid of [
        "http://acme.atlassian.net",
        "https://localhost",
        "https://collector.example",
        "https://atlassian.net.evil.example",
        "https://user:token@acme.atlassian.net",
        "https://acme.atlassian.net:8443",
        "https://acme.atlassian.net/wiki",
        "https://acme.atlassian.net#collector"
      ]
    ) {
      assert.isTrue(Result.isFailure(decode(configured(invalid))), invalid)
    }
  })

  it.effect("discovers the authenticated Confluence user and configured space", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient())
      const discovery = yield* adapter.connection.discover

      assert.deepStrictEqual(discovery.account, {
        providerImmutableId: "account-current-user",
        displayName: "Avery Bell"
      })
      assert.deepStrictEqual(discovery.workspace, {
        providerImmutableId: "site-acme",
        displayName: "Acme"
      })
      assert.deepStrictEqual(discovery.resource, {
        providerImmutableId: "space-payments",
        displayName: "Space · space-payments"
      })
    }))

  it.effect("synchronizes lazy space pages, people, attachment metadata, and safe runbook evidence", () =>
    Effect.gen(function*() {
      const spaces: Array<string> = []
      const attachmentCursors: Array<string | null> = []
      let conversions = 0
      const adapter = yield* makeAdapter(
        defaultClient({
          getSpacePages: (spaceId) =>
            Effect.sync(() => {
              spaces.push(spaceId)
              return { results: [currentPage] }
            }),
          getPageAttachments: (pageId, cursor) =>
            Effect.sync(() => {
              assert.strictEqual(pageId, PAGE_ID)
              attachmentCursors.push(cursor)
              return cursor === null
                ? {
                  results: [{
                    id: "attachment-1",
                    status: "current",
                    title: "rollback-checklist.pdf",
                    createdAt: UPDATED_AT,
                    pageId: PAGE_ID,
                    mediaType: "application/pdf",
                    fileSize: 42,
                    version: currentPage.version
                  }],
                  _links: { next: "/wiki/api/v2/pages/page-42/attachments?cursor=attachments%2B2" }
                }
                : {
                  results: [{
                    id: "attachment-2",
                    status: "current",
                    title: "release-map.svg",
                    createdAt: UPDATED_AT,
                    pageId: PAGE_ID
                  }]
                }
            }),
          getPageVersions: () =>
            Effect.succeed({
              results: [currentPage.version, {
                number: 2,
                createdAt: "2026-07-15T08:00:00.000Z",
                authorId: "account-contributor"
              }]
            }),
          getPageWatchers: (pageId, start) =>
            Effect.sync(() => {
              assert.strictEqual(pageId, PAGE_ID)
              assert.strictEqual(start, 0)
              return {
                results: [{
                  type: "watch",
                  contentId: Number(PAGE_ID),
                  watcher: {
                    accountId: "account-watcher",
                    displayName: "Watcher",
                    isExternalCollaborator: false,
                    isGuest: false
                  }
                }],
                start,
                limit: 50,
                size: 1
              }
            })
        }),
        undefined,
        () => {
          conversions += 1
        }
      )

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      assert.strictEqual(pages.length, 1)
      const events = pages[0]?.events ?? []
      const entity = events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)

      assert.deepStrictEqual(spaces, ["space-payments"])
      assert.deepStrictEqual(attachmentCursors, [null, "attachments+2"])
      assert.strictEqual(conversions, 1)
      assert.deepStrictEqual(attributes.content, {
        representation: "safe-markdown",
        markdown: "Runbook\n"
      })
      assert.strictEqual(attributes.contentState, "loaded")
      assert.deepStrictEqual(attributes.versions.map(({ number }) => number), [3, 2])
      assert.deepStrictEqual(attributes.versionHistory, { complete: true, pagesFetched: 1 })
      assert.deepStrictEqual(attributes.attachmentInventory, { complete: true, pagesFetched: 2 })
      assert.deepStrictEqual(attributes.watcherInventory, { complete: true, pagesFetched: 1 })
      assert.deepStrictEqual(attributes.attachments, [{
        id: "attachment-1",
        title: "rollback-checklist.pdf",
        createdAt: UPDATED_AT,
        mediaType: "application/pdf",
        fileSize: 42,
        version: 3
      }, {
        id: "attachment-2",
        title: "release-map.svg",
        createdAt: UPDATED_AT,
        mediaType: null,
        fileSize: null,
        version: null
      }])
      const people = events.filter((event) => event._tag === "UpsertPerson")
      assert.strictEqual(people.length, 4)
      assert.exists(people.find(({ vendorPersonId }) => vendorPersonId === "account-watcher"))
      const runbook = events.find((event) => event._tag === "AppendEvidence")
      assert.exists(runbook)
      if (runbook?._tag === "AppendEvidence") {
        assert.strictEqual(runbook.evidenceType, "confluence.runbook-candidate")
        assert.deepStrictEqual(runbook.data, {
          schemaVersion: 1,
          basis: "title-keyword",
          pageId: PAGE_ID,
          spaceId: "space-payments"
        })
      }
    }))

  it.effect("marks watcher metadata incomplete when the OAuth grant lacks watcher scope", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPageWatchers: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-watchers",
              reason: "authorization",
              retryAfterSeconds: null
            })
          )
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const entity = pages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)
      assert.deepStrictEqual(attributes.watcherInventory, { complete: false, pagesFetched: 0 })
    }))

  it.effect("keeps pages lazy when conversion produces only whitespace", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient(), "  \n")

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const entity = pages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)

      assert.strictEqual(attributes.content, null)
      assert.strictEqual(attributes.contentState, "lazy")
    }))

  it.effect("marks watcher metadata incomplete when the classic endpoint reports OAuth scope mismatch as 401", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(
        defaultClient({
          getPageWatchers: () =>
            Effect.fail(
              new ConfluencePageClientFailure({
                operation: "confluence-page-watchers",
                reason: "authentication",
                retryAfterSeconds: null
              })
            )
        })
      )

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const entity = pages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)
      assert.deepStrictEqual(attributes.watcherInventory, { complete: false, pagesFetched: 0 })
    }))

  it.effect("caps new watcher contributors while retaining watcher roles for known contributors", () =>
    Effect.gen(function*() {
      const versions = Array.from({ length: 500 }, (_, index) => ({
        number: index + 1,
        createdAt: UPDATED_AT,
        authorId: `v${String(index).padStart(3, "0")}`
      }))
      const page = {
        ...currentPage,
        ownerId: "page-owner",
        version: { ...currentPage.version, authorId: "page-author" }
      }
      const makeVersionReader = () => {
        let pageNumber = 0
        return () =>
          Effect.sync(() => {
            const index = pageNumber
            pageNumber += 1
            return {
              results: versions.slice(index * 100, (index + 1) * 100),
              ...(index < 4 ? { _links: { next: `/versions?cursor=page-${index + 1}` } } : {})
            }
          })
      }
      const watcherPage = (accountId: string) => ({
        results: [{ type: "watch", contentId: Number(PAGE_ID), watcher: { accountId } }],
        start: 0,
        limit: 50,
        size: 1
      })
      const cappedAdapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [page] }),
        getPageVersions: makeVersionReader(),
        getPageWatchers: () => Effect.succeed(watcherPage("watcher-over-budget"))
      }))
      const cappedPages = yield* cappedAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const cappedEntity = cappedPages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(cappedEntity)
      if (cappedEntity?._tag !== "UpsertEntity") return
      const capped = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(cappedEntity.attributes)
      assert.strictEqual(capped.contributors.length, 502)
      assert.isFalse(capped.contributors.some(({ accountId }) => accountId === "watcher-over-budget"))
      assert.deepStrictEqual(capped.watcherInventory, { complete: false, pagesFetched: 1 })

      const retainedAdapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [page] }),
        getPageVersions: makeVersionReader(),
        getPageWatchers: () => Effect.succeed(watcherPage("v000"))
      }))
      const retainedPages = yield* retainedAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const retainedEntity = retainedPages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(retainedEntity)
      if (retainedEntity?._tag !== "UpsertEntity") return
      const retained = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(retainedEntity.attributes)
      assert.strictEqual(retained.contributors.length, 502)
      assert.include(
        retained.contributors.find(({ accountId }) => accountId === "v000")?.roles ?? [],
        "watcher"
      )
      assert.deepStrictEqual(retained.watcherInventory, { complete: true, pagesFetched: 1 })
    }))

  it.effect("omits version messages to keep sync attributes within the byte budget", () =>
    Effect.gen(function*() {
      const versions = Array.from({ length: 500 }, (_, index) => ({
        number: index + 1,
        createdAt: UPDATED_AT,
        message: `${index}-${"m".repeat(1_990)}`,
        authorId: "account-author"
      }))
      const makeVersionReader = () => {
        let pageNumber = 0
        return () =>
          Effect.sync(() => {
            const index = pageNumber
            pageNumber += 1
            return {
              results: versions.slice(index * 100, (index + 1) * 100),
              ...(index < 4 ? { _links: { next: `/versions?cursor=page-${index + 1}` } } : {})
            }
          })
      }
      const largeAdapter = yield* makeAdapter(defaultClient({
        getPageVersions: makeVersionReader()
      }))
      const largePages = yield* largeAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const largeEntity = largePages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(largeEntity)
      if (largeEntity?._tag !== "UpsertEntity") return
      const large = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(largeEntity.attributes)
      assert.strictEqual(large.versions.length, 500)
      assert.isFalse(large.versionHistory.complete)
      assert.isTrue(large.versions.some(({ message }) => message === null))
      assert.isAtMost(jsonBytes(large), MaximumPluginPayloadBytes)

      const smallAdapter = yield* makeAdapter(defaultClient({
        getPageVersions: () => Effect.succeed({ results: [currentPage.version] })
      }))
      const smallPages = yield* smallAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const smallEntity = smallPages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(smallEntity)
      if (smallEntity?._tag !== "UpsertEntity") return
      const small = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(smallEntity.attributes)
      assert.strictEqual(small.versions[0]?.message, currentPage.version.message)
      assert.isTrue(small.versionHistory.complete)
    }))

  it.effect("marks a full synthesized history incomplete only when synthesis drops a provider version", () =>
    Effect.gen(function*() {
      const withoutCurrent = Array.from({ length: 500 }, (_, index) => ({
        number: 1_000 + index,
        createdAt: UPDATED_AT,
        authorId: "account-author"
      }))
      const withCurrent = [currentPage.version, ...withoutCurrent.slice(0, 499)]
      const readHistory = (versions: ReadonlyArray<(typeof withoutCurrent)[number] | typeof currentPage.version>) => {
        let pageNumber = 0
        return () =>
          Effect.sync(() => {
            const index = pageNumber
            pageNumber += 1
            return {
              results: versions.slice(index * 100, (index + 1) * 100),
              ...(index < 4 ? { _links: { next: `/versions?cursor=page-${index + 1}` } } : {})
            }
          })
      }
      const missingAdapter = yield* makeAdapter(defaultClient({ getPageVersions: readHistory(withoutCurrent) }))
      const missingPages = yield* missingAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const missingEntity = missingPages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(missingEntity)
      if (missingEntity?._tag !== "UpsertEntity") return
      const missing = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(missingEntity.attributes)
      assert.strictEqual(missing.versions.length, 500)
      assert.strictEqual(missing.versions[0]?.number, currentPage.version.number)
      assert.isFalse(missing.versionHistory.complete)

      const presentAdapter = yield* makeAdapter(defaultClient({ getPageVersions: readHistory(withCurrent) }))
      const presentPages = yield* presentAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const presentEntity = presentPages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(presentEntity)
      if (presentEntity?._tag !== "UpsertEntity") return
      const present = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(presentEntity.attributes)
      assert.strictEqual(present.versions.length, 500)
      assert.isTrue(present.versionHistory.complete)
    }))

  it.effect("keeps privacy-limited contributors out of people events", () =>
    Effect.gen(function*() {
      const unresolvedAdapter = yield* makeAdapter(defaultClient({
        getUsers: () => Effect.succeed({ results: [] })
      }))
      const unresolvedPages = yield* unresolvedAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const unresolvedPeople = unresolvedPages.flatMap(({ events }) =>
        events.filter((event) => event._tag === "UpsertPerson")
      )
      assert.lengthOf(unresolvedPeople, 0)

      const resolvedAdapter = yield* makeAdapter(defaultClient({
        getUsers: (accountIds) =>
          Effect.succeed({
            results: accountIds.map((accountId) => ({
              accountId,
              displayName: `Resolved ${accountId}`,
              accountStatus: "active"
            }))
          })
      }))
      const resolvedPages = yield* resolvedAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const resolvedPeople = resolvedPages.flatMap(({ events }) =>
        events.filter((event) => event._tag === "UpsertPerson")
      )
      assert.isAbove(resolvedPeople.length, 0)
      for (const person of resolvedPeople) {
        if (person._tag === "UpsertPerson") assert.match(person.displayName, /^Resolved /u)
      }
    }))

  it.effect("skips privacy-redacted watcher identities and keeps visible watcher roles", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPageWatchers: () =>
          Effect.succeed({
            results: [
              {
                type: "watch",
                contentId: Number(PAGE_ID),
                watcher: { accountId: "account-watcher", displayName: "" }
              },
              {
                type: "watch",
                contentId: Number(PAGE_ID),
                watcher: { accountId: null }
              }
            ],
            start: 0,
            limit: 50,
            size: 2
          }),
        getPageAttachments: () =>
          Effect.succeed({
            results: [{
              id: "attachment-minimal-version",
              status: "current",
              title: "release.txt",
              createdAt: UPDATED_AT,
              pageId: PAGE_ID,
              version: { number: 1 }
            }]
          })
      }))
      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const entity = pages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)
      assert.deepStrictEqual(attributes.attachments?.map(({ id, version }) => ({ id, version })), [{
        id: "attachment-minimal-version",
        version: 1
      }])
      assert.include(
        attributes.contributors.find(({ accountId }) => accountId === "account-watcher")?.roles ?? [],
        "watcher"
      )
      assert.deepStrictEqual(attributes.watcherInventory, { complete: false, pagesFetched: 1 })
      assert.isFalse(
        pages.flatMap(({ events }) => events).some(
          (event) => event._tag === "UpsertPerson" && event.vendorPersonId === null
        )
      )
    }))

  it.effect("treats watcher ownership for unsafe numeric page ids as unverifiable", () =>
    Effect.gen(function*() {
      const unsafePageId = "9007199254740993"
      const unsafePage = {
        ...currentPage,
        id: unsafePageId,
        _links: { webui: `/wiki/spaces/PAY/pages/${unsafePageId}` }
      }
      const unsafeAdapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [unsafePage] }),
        getPageVersions: () => Effect.succeed({ results: [unsafePage.version] }),
        getPageWatchers: () =>
          Effect.succeed({
            results: [{
              type: "watch",
              contentId: Number(unsafePageId),
              watcher: { accountId: "account-watcher" }
            }],
            start: 0,
            limit: 50,
            size: 1
          })
      }))

      const unsafePages = yield* unsafeAdapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const unsafeEntity = unsafePages[0]?.events.find((event) => event._tag === "UpsertEntity")
      assert.exists(unsafeEntity)
      if (unsafeEntity?._tag !== "UpsertEntity") return
      const unsafeAttributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(unsafeEntity.attributes)
      assert.deepStrictEqual(unsafeAttributes.watcherInventory, { complete: false, pagesFetched: 1 })
      assert.isFalse(unsafeAttributes.contributors.some(({ accountId }) => accountId === "account-watcher"))

      const mismatchedAdapter = yield* makeAdapter(defaultClient({
        getPageWatchers: () =>
          Effect.succeed({
            results: [{ type: "watch", contentId: 43, watcher: { accountId: "account-watcher" } }],
            start: 0,
            limit: 50,
            size: 1
          })
      }))
      const mismatch = yield* mismatchedAdapter.connection.sync(syncRequest).pipe(
        Stream.runCollect,
        Effect.result
      )
      assert.isTrue(Result.isFailure(mismatch))
      if (Result.isFailure(mismatch)) {
        assert.strictEqual(mismatch.failure._tag, "PluginMalformedResponseFailure")
        if (mismatch.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(mismatch.failure.diagnosticCode, "confluence-watcher-page-mismatch")
        }
      }
    }))

  it.effect("compacts maximum-length version and contributor identities within the payload bound", () =>
    Effect.gen(function*() {
      const accountId = (index: number) => `${String(index).padStart(4, "0")}${"a".repeat(508)}`
      const versions = Array.from({ length: 500 }, (_, index) => ({
        number: index + 1,
        createdAt: UPDATED_AT,
        message: "bounded message",
        authorId: accountId(index)
      }))
      let pageNumber = 0
      const adapter = yield* makeAdapter(defaultClient({
        getPageVersions: () =>
          Effect.sync(() => {
            const index = pageNumber
            pageNumber += 1
            return {
              results: versions.slice(index * 100, (index + 1) * 100),
              ...(index < 4 ? { _links: { next: `/versions?cursor=page-${index + 1}` } } : {})
            }
          }),
        getUsers: (accountIds) =>
          Effect.succeed({
            results: accountIds.map((accountId) => ({
              accountId,
              displayName: "Visible contributor",
              accountStatus: "active"
            }))
          })
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const entity = pages.flatMap(({ events }) => events).find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)
      assert.isFalse(attributes.versionHistory.complete)
      assert.isBelow(attributes.versions.length + attributes.contributors.length, 1_002)
      assert.isAtMost(jsonBytes(attributes), MaximumPluginPayloadBytes)
    }))

  it.effect("keeps privacy-redacted bulk profiles unresolved without suppressing visible people", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getUsers: (accountIds) =>
          Effect.succeed({
            results: accountIds.map((accountId) =>
              accountId === "account-author"
                ? { accountId, accountStatus: "active" }
                : { accountId, displayName: `Visible ${accountId}`, accountStatus: "active" }
            )
          })
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const events = pages.flatMap(({ events }) => events)
      const entity = events.find((event) => event._tag === "UpsertEntity")
      assert.exists(entity)
      if (entity?._tag !== "UpsertEntity") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(entity.attributes)
      assert.deepInclude(
        attributes.contributors.find(({ accountId }) => accountId === "account-author"),
        { displayName: "Confluence user", resolved: false }
      )
      assert.isFalse(
        events.some((event) => event._tag === "UpsertPerson" && event.vendorPersonId === "account-author")
      )
      assert.isTrue(
        events.some((event) => event._tag === "UpsertPerson" && event.vendorPersonId === "account-owner")
      )
    }))

  it.effect("rejects pages from another space before reading their attachments", () =>
    Effect.gen(function*() {
      const spaces: Array<string> = []
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: (spaceId) =>
          Effect.sync(() => {
            spaces.push(spaceId)
            return { results: [{ ...currentPage, spaceId: "space-other" }] }
          }),
        getPageAttachments: () => Effect.die("cross-space pages must be rejected before attachment reads")
      }))

      const outcome = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect, Effect.result)

      assert.deepStrictEqual(spaces, ["space-payments"])
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
      }
    }))

  it.effect("stops at the bounded page limit and resumes from its durable cursor", () =>
    Effect.gen(function*() {
      const cursors: Array<string | null> = []
      const client = defaultClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            const index = cursor === null ? 0 : Number(cursor.slice(1))
            return index < 5
              ? { results: [], _links: { next: `/wiki/api/v2/spaces/space-payments/pages?cursor=c${index + 1}` } }
              : { results: [] }
          })
      })
      const adapter = yield* makeAdapter(client)

      const first = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      assert.strictEqual(first.length, 5)
      assert.strictEqual(first[4]?.hasMore, false)
      assert.match(first[4]?.checkpointAfterPage ?? "", /^bounded:v1:[0-9a-f]{64}:c5$/u)
      assert.deepStrictEqual(cursors, [null, "c1", "c2", "c3", "c4"])

      cursors.length = 0
      const resumed = yield* adapter.connection.sync(
        Schema.decodeUnknownSync(PluginSyncRequestV1)({
          streamKey: "pages",
          checkpoint: first[4]?.checkpointAfterPage
        })
      ).pipe(Stream.runCollect)
      assert.strictEqual(resumed.length, 1)
      assert.match(
        resumed[0]?.checkpointAfterPage ?? "",
        /^complete:v1:[0-9a-f]{64}:[0-9a-f]{64}:c5$/u
      )
      assert.deepStrictEqual(cursors, ["c5"])
    }))

  it.effect("rejects non-advancing resumed cursors before reading page metadata", () =>
    Effect.gen(function*() {
      let metadataCalls = 0
      const repeating = yield* makeAdapter(defaultClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.succeed({ results: [currentPage], _links: { next: `/pages?cursor=${cursor}` } }),
        getPageVersions: () =>
          Effect.sync(() => {
            metadataCalls += 1
            return { results: [currentPage.version] }
          })
      }))
      const repeated = yield* repeating.connection.sync(
        Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "pages", checkpoint: "next:c1" })
      ).pipe(Stream.runCollect, Effect.result)
      assert.isTrue(Result.isFailure(repeated))
      assert.strictEqual(metadataCalls, 0)

      const cursors: Array<string | null> = []
      const advancing = yield* makeAdapter(defaultClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            return cursor === "c1"
              ? { results: [], _links: { next: "/pages?cursor=c2" } }
              : { results: [] }
          })
      }))
      const advanced = yield* advancing.connection.sync(
        Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "pages", checkpoint: "next:c1" })
      ).pipe(Stream.runCollect)
      assert.deepStrictEqual(cursors, ["c1", "c2"])
      assert.strictEqual(advanced[0]?.checkpointAfterPage, "next:c2")
      assert.match(advanced[1]?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
    }))

  it.effect("tracks pagination cursors independently for each wrapped sync retry", () =>
    Effect.gen(function*() {
      let versionCalls = 0
      const cursors: Array<string | null> = []
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            return cursor === null
              ? { results: [currentPage], _links: { next: "/pages?cursor=c1" } }
              : { results: [] }
          }),
        getPageVersions: () =>
          Effect.suspend(() => {
            versionCalls += 1
            return versionCalls === 1
              ? Effect.fail(
                new ConfluencePageClientFailure({
                  operation: "confluence-page-version-history",
                  reason: "rate-limit",
                  retryAfterSeconds: 0
                })
              )
              : Effect.succeed({ results: [currentPage.version] })
          })
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(
        Stream.retry(Schedule.recurs(1)),
        Stream.runCollect
      )

      assert.deepStrictEqual(cursors, [null, null, "c1"])
      assert.strictEqual(versionCalls, 2)
      assert.strictEqual(pages.length, 2)
      assert.strictEqual(pages[0]?.checkpointAfterPage, "next:c1")
      assert.match(pages[1]?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
    }))

  it.effect("reserves enough checkpoint budget for two provider cursors", () =>
    Effect.gen(function*() {
      const maximumCursorLength = Math.floor(
        (2_048 - "bounded:v2:".length - 9 - 1 - 64 - 1 - 4 - 1 - 64 - 1) / 2
      )
      const prefixCursor = "p".repeat(maximumCursorLength)
      const suffixCursor = "s".repeat(maximumCursorLength)
      const validCalls: Array<string | null> = []
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.sync(() => {
            validCalls.push(cursor)
            if (cursor === suffixCursor) return { results: [] }
            if (cursor === prefixCursor) return { results: [], _links: { next: `/pages?cursor=${suffixCursor}` } }
            const index = cursor === null ? 0 : Number(cursor.slice(1))
            return {
              results: [],
              _links: { next: `/pages?cursor=${index === 4 ? prefixCursor : `c${index + 1}`}` }
            }
          })
      }))

      const bounded = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const valid = yield* adapter.connection.sync(
        Schema.decodeUnknownSync(PluginSyncRequestV1)({
          streamKey: "pages",
          checkpoint: bounded[4]?.checkpointAfterPage
        })
      ).pipe(Stream.runCollect)
      assert.deepStrictEqual(validCalls, [null, "c1", "c2", "c3", "c4", prefixCursor, suffixCursor])
      assert.lengthOf(valid, 2)
      for (const page of valid) {
        assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PluginCheckpointV1)(page.checkpointAfterPage)))
      }
      assert.match(
        valid[0]?.checkpointAfterPage ?? "",
        /^bounded:v2:0:[0-9a-f]{64}:[0-9]{3}:[p]+[0-9a-f]{64}:[s]+$/u
      )

      validCalls.length = 0
      const overlongCursor = "c".repeat(maximumCursorLength + 1)
      const invalid = yield* adapter.connection.sync(
        Schema.decodeUnknownSync(PluginSyncRequestV1)({
          streamKey: "pages",
          checkpoint: `bounded:${overlongCursor}`
        })
      ).pipe(Stream.runCollect, Effect.result)
      assert.isTrue(Result.isFailure(invalid))
      assert.deepStrictEqual(validCalls, [])

      assert.isTrue(Result.isFailure(
        Schema.decodeUnknownResult(PluginCheckpointV1)(
          `bounded:v2:0:${"a".repeat(64)}:999:${"p".repeat(999)}${"b".repeat(64)}:${"s".repeat(999)}`
        )
      ))
    }))

  it.effect("changes sync event identity only when mutable inventory changes", () =>
    Effect.gen(function*() {
      let attachmentTitle = "release-v1.txt"
      let displayName = "Avery One"
      const adapter = yield* makeAdapter(defaultClient({
        getPageAttachments: () =>
          Effect.sync(() => ({
            results: [{
              id: "attachment-1",
              status: "current",
              title: attachmentTitle,
              createdAt: UPDATED_AT,
              pageId: PAGE_ID,
              version: { number: 1 }
            }]
          })),
        getUsers: (accountIds) =>
          Effect.sync(() => ({
            results: accountIds.map((accountId) => ({
              accountId,
              displayName,
              accountStatus: "active"
            }))
          }))
      }))
      const eventIds = Effect.fn("ConfluencePageAdapterTest.eventIds")(function*() {
        const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
        return pages.flatMap(({ events }) => events.map(({ eventId }) => eventId))
      })
      const initial = yield* eventIds()
      const replay = yield* eventIds()
      assert.deepStrictEqual(replay, initial)

      attachmentTitle = "release-v2.txt"
      displayName = "Avery Two"
      const changed = yield* eventIds()
      assert.notDeepEqual(changed, initial)
    }))

  it.effect("hashes runbook evidence identity for maximum-length Confluence page ids", () =>
    Effect.gen(function*() {
      const pageId = "9".repeat(512)
      const page = {
        ...currentPage,
        id: pageId,
        _links: { webui: `/wiki/spaces/PAY/pages/${pageId}` }
      }
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: [page] }),
        getPageVersions: () => Effect.succeed({ results: [page.version] })
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)
      const evidence = pages.flatMap(({ events }) => events).filter((event) => event._tag === "AppendEvidence")
      assert.lengthOf(evidence, 1)
      assert.isAtMost(evidence[0]?.eventId.length ?? Number.POSITIVE_INFINITY, 512)
      assert.isAtMost(evidence[0]?.evidenceId.length ?? Number.POSITIVE_INFINITY, 512)
      assert.deepInclude(evidence[0]?.data, { pageId })
    }))

  it.effect("splits attachment-heavy provider pages without losing restart safety", () =>
    Effect.gen(function*() {
      const sourcePages = Array.from({ length: 20 }, (_, index) => ({
        ...currentPage,
        id: `page-${index}`,
        title: `Operations runbook ${index}`,
        _links: { webui: `/wiki/spaces/PAY/pages/page-${index}` }
      }))
      const adapter = yield* makeAdapter(defaultClient({
        getSpacePages: () => Effect.succeed({ results: sourcePages }),
        getPageAttachments: (pageId, cursor) => {
          const offset = cursor === null ? 0 : 25
          return Effect.succeed({
            results: Array.from({ length: 25 }, (_, index) => ({
              id: `${pageId}-attachment-${offset + index}-${"i".repeat(440)}`,
              status: "current",
              title: `artifact-${offset + index}-${"t".repeat(470)}`,
              createdAt: UPDATED_AT,
              pageId,
              mediaType: `application/vnd.${"m".repeat(230)}`,
              fileSize: index,
              version: currentPage.version
            })),
            ...(cursor === null
              ? { _links: { next: `/wiki/api/v2/pages/${pageId}/attachments?cursor=second` } }
              : {})
          })
        }
      }))

      const pages = yield* adapter.connection.sync(syncRequest).pipe(Stream.runCollect)

      assert.isAbove(pages.length, 1)
      for (const page of pages) assert.isAtMost(jsonBytes(page), MaximumPluginSyncPageBytes)
      for (const page of pages.slice(0, -1)) {
        assert.strictEqual(page.hasMore, true)
        assert.strictEqual(page.checkpointAfterPage, "restart:initial")
      }
      assert.match(pages.at(-1)?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
      assert.strictEqual(
        pages.flatMap(({ events }) => events).filter(({ _tag }) => _tag === "UpsertEntity").length,
        sourcePages.length
      )
    }))

  it.effect("rejects a configured site identity that does not match Confluence", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getSystemInfo: Effect.succeed({ cloudId: "site-other", commitHash: "commit" })
      }))
      const outcome = yield* adapter.connection.discover.pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "confluence-site-identity-mismatch")
        }
      }
    }))

  it.effect("uses the already-verified OAuth cloud ID without requesting system information", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(
        defaultClient({ getSystemInfo: Effect.die("OAuth discovery must not require Confluence settings scope") }),
        undefined,
        undefined,
        { ...configuration, oauthVerifiedSiteId: "site-acme" }
      )
      const discovery = yield* adapter.connection.discover
      assert.strictEqual(discovery.workspace?.providerImmutableId, "site-acme")
    }))

  it.effect("uses the OAuth profile identity without requiring a classic Confluence user scope", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(
        defaultClient({
          getCurrentUser: Effect.die("OAuth discovery must use the already-verified profile identity")
        }),
        undefined,
        undefined,
        {
          ...configuration,
          oauthVerifiedSiteId: "site-acme",
          oauthVerifiedUser: {
            accountId: "account-oauth-user",
            displayName: "OAuth Avery",
            publicName: "OAuth Avery"
          }
        }
      )

      const discovery = yield* adapter.connection.discover

      assert.deepStrictEqual(discovery.account, {
        providerImmutableId: "account-oauth-user",
        displayName: "OAuth Avery"
      })
    }))

  it.effect("uses the public name for a privacy-limited current-user profile", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getCurrentUser: Effect.succeed({
          accountId: "account-private-user",
          displayName: null,
          publicName: "Private Avery"
        })
      }))

      const discovery = yield* adapter.connection.discover

      assert.deepStrictEqual(discovery.account, {
        providerImmutableId: "account-private-user",
        displayName: "Private Avery"
      })
    }))

  it.effect("rejects a current-user profile without an immutable account id", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getCurrentUser: Effect.succeed({ accountId: "", publicName: "Missing identity" })
      }))

      const outcome = yield* adapter.connection.discover.pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "confluence-current-user-invalid")
        }
      }
    }))

  it.effect("normalizes current content, bounded history, contributors, and a same-origin source URL", () =>
    Effect.gen(function*() {
      const cursors: Array<string | null> = []
      const client = defaultClient({
        getPageVersions: (_pageId, cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            return cursor === null
              ? {
                results: [currentPage.version],
                _links: { next: "/wiki/api/v2/pages/page-42/versions?cursor=next%2Bpage" }
              }
              : {
                results: [{
                  number: 2,
                  createdAt: "2026-07-15T08:00:00.000Z",
                  message: "Add rollback",
                  minorEdit: true,
                  authorId: "account-contributor"
                }]
              }
          }),
        getUsers: (accountIds) =>
          Effect.succeed({
            results: accountIds.map((accountId) => ({
              accountId,
              displayName: accountId.replace("account-", ""),
              accountStatus: accountId === "account-contributor" ? "inactive" : "active",
              isExternalCollaborator: accountId === "account-contributor"
            }))
          })
      })
      const markdown = [
        "<!-- adf:{\"node\":1} -->",
        "# Rollout",
        "[unsafe destination](javascript:alert(1))",
        "![remote image](https://images.example/secret.png)",
        "<script>window.bad = true</script>",
        "leftover ](javascript:run)"
      ].join("\n")
      const adapter = yield* makeAdapter(client, markdown)
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      assert.strictEqual(result.event.entityType, "confluence-page")
      assert.strictEqual(result.event.vendorImmutableId, PAGE_ID)
      assert.strictEqual(result.event.revision, "3")
      assert.strictEqual(
        result.event.sourceUrl?.toString(),
        `https://acme.atlassian.net/wiki/spaces/PAY/pages/${PAGE_ID}`
      )
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.deepStrictEqual(cursors, [null, "next+page"])
      assert.strictEqual(attributes.versionHistory.complete, true)
      assert.strictEqual(attributes.versionHistory.pagesFetched, 2)
      assert.deepStrictEqual(attributes.versions.map(({ number }) => number), [3, 2])
      assert.deepStrictEqual(
        attributes.contributors.map(({ accountId, active, external, roles }) => ({
          accountId,
          active,
          external,
          roles
        })),
        [
          { accountId: "account-author", active: true, external: false, roles: ["author", "contributor"] },
          { accountId: "account-contributor", active: false, external: true, roles: ["contributor"] },
          { accountId: "account-owner", active: true, external: false, roles: ["owner"] }
        ]
      )
      assert.isNotNull(attributes.content)
      assert.notInclude(attributes.content?.markdown, "javascript:")
      assert.notInclude(attributes.content?.markdown, "https://images.example")
      assert.notInclude(attributes.content?.markdown, "<!--")
      assert.notInclude(attributes.content?.markdown, "<script>")
      assert.notInclude(attributes.content?.markdown, "](")
    }))

  it.effect("removes newline-bearing raw HTML while preserving multiline plain text", () =>
    Effect.gen(function*() {
      const markdown = [
        "First plain-text line",
        "<span data-color=\"green",
        "onmouseover=\"alert(1)\">Status</span>",
        "Second plain-text line"
      ].join("\n")
      const adapter = yield* makeAdapter(defaultClient(), markdown)
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.strictEqual(
        attributes.content?.markdown,
        "First plain-text line\nStatus\nSecond plain-text line\n"
      )
      assert.notInclude(attributes.content?.markdown, "<span")
      assert.notInclude(attributes.content?.markdown, "onmouseover")
    }))

  it.effect("preserves link-shaped literals in code while sanitizing prose", () =>
    Effect.gen(function*() {
      const markdown = [
        "Ordinary [docs](https://example.test/docs)",
        "Inline `[label](https://example.test)` example",
        "| Code |",
        "| --- |",
        "| `[table](https://example.test/table)` |",
        "```ts",
        "const sample = \"[label](https://example.test)\"",
        "```",
        "<span onclick=\"alert(1)\">Unsafe prose</span>"
      ].join("\n")
      const adapter = yield* makeAdapter(defaultClient(), markdown)
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.strictEqual(
        attributes.content?.markdown,
        [
          "Ordinary docs",
          "Inline `[label](https://example.test)` example",
          "| Code |",
          "| --- |",
          "| `[table](https://example.test/table)` |",
          "```ts",
          "const sample = \"[label](https://example.test)\"",
          "```",
          "Unsafe prose",
          ""
        ].join("\n")
      )
      assert.notInclude(attributes.content?.markdown, "Ordinary [docs]")
      assert.notInclude(attributes.content?.markdown, "<span")
      assert.notInclude(attributes.content?.markdown, "onclick")
    }))

  it.effect("drops same-origin source URLs with userinfo while retaining relative links", () =>
    Effect.gen(function*() {
      const credentialedAdapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            _links: { webui: `https://user:secret@acme.atlassian.net/wiki/pages/${PAGE_ID}` }
          })
      }))
      const credentialed = yield* credentialedAdapter.connection.readEntity(request)

      assert.strictEqual(credentialed._tag, "found")
      if (credentialed._tag !== "found") return
      assert.isNull(credentialed.event.sourceUrl)

      const relativeAdapter = yield* makeAdapter(defaultClient())
      const relative = yield* relativeAdapter.connection.readEntity(request)

      assert.strictEqual(relative._tag, "found")
      if (relative._tag !== "found") return
      assert.strictEqual(
        relative.event.sourceUrl?.toString(),
        `https://acme.atlassian.net/wiki/spaces/PAY/pages/${PAGE_ID}`
      )
    }))

  it.effect("restores the Confluence context path when webui omits wiki", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            _links: { webui: `/spaces/PAY/pages/${PAGE_ID}/Payments+release+runbook` }
          })
      }))
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      assert.strictEqual(
        result.event.sourceUrl?.toString(),
        `https://acme.atlassian.net/wiki/spaces/PAY/pages/${PAGE_ID}/Payments+release+runbook`
      )
    }))

  it.effect("assigns the author role to the current editor rather than the page creator", () =>
    Effect.gen(function*() {
      const editedPage = {
        ...currentPage,
        authorId: "account-creator",
        version: { ...currentPage.version, authorId: "account-editor" }
      }
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () => Effect.succeed(editedPage),
        getPageVersions: () =>
          Effect.succeed({
            results: [
              editedPage.version,
              {
                number: 2,
                createdAt: "2026-07-15T08:00:00.000Z",
                authorId: "account-creator"
              }
            ]
          })
      }))
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.deepStrictEqual(
        attributes.contributors.map(({ accountId, roles }) => ({ accountId, roles })),
        [
          { accountId: "account-creator", roles: ["contributor"] },
          { accountId: "account-editor", roles: ["author", "contributor"] },
          { accountId: "account-owner", roles: ["owner"] }
        ]
      )
    }))

  it.effect("marks missing, unknown, and status-less user profiles unresolved and inactive", () =>
    Effect.gen(function*() {
      const client = defaultClient({
        getPageVersions: () =>
          Effect.succeed({
            results: [
              currentPage.version,
              {
                number: 2,
                createdAt: "2026-07-15T08:00:00.000Z",
                authorId: "account-missing"
              },
              {
                number: 1,
                createdAt: "2026-07-14T08:00:00.000Z",
                authorId: "account-no-status"
              }
            ]
          }),
        getUsers: () =>
          Effect.succeed({
            results: [
              {
                accountId: "account-author",
                displayName: "author",
                accountStatus: "active",
                isExternalCollaborator: false
              },
              {
                accountId: "account-no-status",
                displayName: "no status",
                isExternalCollaborator: false
              },
              {
                accountId: "account-owner",
                displayName: "owner",
                accountStatus: "unknown",
                isExternalCollaborator: false
              }
            ]
          })
      })
      const adapter = yield* makeAdapter(client)
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.deepStrictEqual(
        attributes.contributors.map(({ accountId, active, resolved }) => ({ accountId, active, resolved })),
        [
          { accountId: "account-author", active: true, resolved: true },
          { accountId: "account-missing", active: false, resolved: false },
          { accountId: "account-no-status", active: false, resolved: false },
          { accountId: "account-owner", active: false, resolved: false }
        ]
      )
    }))

  it.effect("returns unresolved inactive contributors when profile lookup is forbidden", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getUsers: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-user-lookup",
              reason: "authorization",
              retryAfterSeconds: null
            })
          )
      }))
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.deepStrictEqual(
        attributes.contributors.map(({ accountId, active, resolved }) => ({ accountId, active, resolved })),
        [
          { accountId: "account-author", active: false, resolved: false },
          { accountId: "account-owner", active: false, resolved: false }
        ]
      )
    }))

  it.effect("returns unresolved inactive contributors when OAuth scope mismatch is reported as 401", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(
        defaultClient({
          getUsers: () =>
            Effect.fail(
              new ConfluencePageClientFailure({
                operation: "confluence-user-lookup",
                reason: "authentication",
                retryAfterSeconds: null
              })
            )
        })
      )
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.deepStrictEqual(
        attributes.contributors.map(({ accountId, active, resolved }) => ({ accountId, active, resolved })),
        [
          { accountId: "account-author", active: false, resolved: false },
          { accountId: "account-owner", active: false, resolved: false }
        ]
      )
    }))

  it.effect("keeps non-authorization profile lookup failures fatal", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getUsers: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-user-lookup",
              reason: "outage",
              retryAfterSeconds: null
            })
          )
      }))
      const outcome = yield* adapter.connection.readEntity(request).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "PluginOutageFailure")
    }))

  it.effect("rejects pages outside the configured space before history, users, or content", () =>
    Effect.gen(function*() {
      let versionCalls = 0
      let userCalls = 0
      let conversionCalls = 0
      const client = defaultClient({
        getPage: () => Effect.succeed({ ...currentPage, spaceId: "space-other" }),
        getPageVersions: () =>
          Effect.sync(() => {
            versionCalls += 1
            return { results: [] }
          }),
        getUsers: () =>
          Effect.sync(() => {
            userCalls += 1
            return { results: [] }
          })
      })
      const adapter = yield* makeAdapter(client, undefined, () => {
        conversionCalls += 1
      })

      const read = yield* adapter.connection.readEntity(request).pipe(Effect.result)
      const health = yield* adapter.connection.health.pipe(Effect.result)

      assert.isTrue(Result.isFailure(read))
      if (Result.isFailure(read)) {
        assert.strictEqual(read.failure._tag, "PluginMalformedResponseFailure")
        if (read.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(read.failure.diagnosticCode, "confluence-page-space-mismatch")
        }
      }
      assert.isTrue(Result.isFailure(health))
      if (Result.isFailure(health)) {
        assert.strictEqual(health.failure._tag, "PluginMalformedResponseFailure")
        if (health.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(health.failure.diagnosticCode, "confluence-page-space-mismatch")
        }
      }
      assert.strictEqual(versionCalls, 0)
      assert.strictEqual(userCalls, 0)
      assert.strictEqual(conversionCalls, 0)
    }))

  it.effect("accepts a space homepage with a null parent as the health probe", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(
        defaultClient({
          getPage: () => Effect.succeed({ ...currentPage, parentId: null })
        })
      )

      const health = yield* adapter.connection.health

      assert.strictEqual(health._tag, "healthy")
    }))

  it.effect("stops version traversal at five pages and marks history incomplete", () =>
    Effect.gen(function*() {
      let calls = 0
      const adapter = yield* makeAdapter(defaultClient({
        getPageVersions: () =>
          Effect.sync(() => {
            calls += 1
            return {
              results: [{
                number: calls,
                createdAt: UPDATED_AT,
                authorId: "account-author"
              }],
              _links: { next: `/versions?cursor=page-${calls + 1}` }
            }
          })
      }))
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.strictEqual(calls, 5)
      assert.strictEqual(attributes.versionHistory.complete, false)
      assert.strictEqual(attributes.versionHistory.pagesFetched, 5)
    }))

  it.effect("retains the complete bounded set of 500 version authors plus page author and owner", () =>
    Effect.gen(function*() {
      const versions = Array.from({ length: 500 }, (_, index) => ({
        number: index + 1,
        createdAt: UPDATED_AT,
        authorId: `v${String(index).padStart(3, "0")}`
      }))
      let versionPage = 0
      const userBatches: Array<ReadonlyArray<string>> = []
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.succeed({
            ...currentPage,
            authorId: "page-author",
            ownerId: "page-owner",
            version: { ...currentPage.version, authorId: "page-author" }
          }),
        getPageVersions: () =>
          Effect.sync(() => {
            const page = versionPage
            versionPage += 1
            return {
              results: versions.slice(page * 100, (page + 1) * 100),
              ...(page < 4 ? { _links: { next: `/versions?cursor=page-${page + 1}` } } : {})
            }
          }),
        getUsers: (accountIds) =>
          Effect.sync(() => {
            userBatches.push(accountIds)
            return {
              results: accountIds.map((accountId) => ({
                accountId,
                displayName: "u",
                accountStatus: "active",
                isExternalCollaborator: false
              }))
            }
          })
      }))

      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "found")
      if (result._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(result.event.attributes)
      assert.strictEqual(attributes.versions.length, 500)
      assert.strictEqual(attributes.contributors.length, 502)
      assert.deepStrictEqual(userBatches.map(({ length }) => length), [250, 250, 2])
    }))

  it("accepts exactly 502 normalized contributors and rejects 503", () => {
    const contributors = Array.from({ length: 503 }, (_, index) => ({
      accountId: `account-${index}`,
      displayName: "u",
      active: true,
      external: false,
      resolved: true,
      roles: ["contributor"]
    }))

    assert.isTrue(Result.isSuccess(
      Schema.decodeUnknownResult(ConfluencePageAttributesV1)(
        normalizedAttributes("Runbook\n", contributors.slice(0, 502))
      )
    ))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(ConfluencePageAttributesV1)(normalizedAttributes("Runbook\n", contributors))
    ))
  })

  it.effect("accepts an exact normalized attributes byte budget and reports content overflow", () =>
    Effect.gen(function*() {
      const baselineAdapter = yield* makeAdapter(defaultClient(), "x")
      const baseline = yield* baselineAdapter.connection.readEntity(request)
      assert.strictEqual(baseline._tag, "found")
      if (baseline._tag !== "found") return
      const baselineAttributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(baseline.event.attributes)
      const fittingMarkdown = "x".repeat(
        1 + MaximumPluginPayloadBytes - jsonBytes(baselineAttributes)
      )
      const fittingAdapter = yield* makeAdapter(defaultClient(), fittingMarkdown)
      const fitting = yield* fittingAdapter.connection.readEntity(request)

      assert.strictEqual(fitting._tag, "found")
      if (fitting._tag !== "found") return
      const attributes = Schema.decodeUnknownSync(ConfluencePageAttributesV1)(fitting.event.attributes)
      assert.strictEqual(jsonBytes(attributes), MaximumPluginPayloadBytes)

      const oversizedAdapter = yield* makeAdapter(defaultClient(), `${fittingMarkdown}x`)
      const oversized = yield* oversizedAdapter.connection.readEntity(request).pipe(Effect.result)
      assert.isTrue(Result.isFailure(oversized))
      if (Result.isFailure(oversized)) {
        assert.strictEqual(oversized.failure._tag, "PluginMalformedResponseFailure")
        if (oversized.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(oversized.failure.diagnosticCode, "confluence-content-too-large")
        }
      }
    }))

  it.effect("rejects provider identity drift and repeated pagination cursors", () =>
    Effect.gen(function*() {
      const identityAdapter = yield* makeAdapter(defaultClient({
        getPage: () => Effect.succeed({ ...currentPage, id: "different-page" })
      }))
      const identity = yield* identityAdapter.connection.readEntity(request).pipe(Effect.result)
      assert.isTrue(Result.isFailure(identity))
      if (Result.isFailure(identity)) {
        assert.strictEqual(identity.failure._tag, "PluginMalformedResponseFailure")
        if (identity.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(identity.failure.diagnosticCode, "confluence-page-identity-mismatch")
        }
      }

      const cursorAdapter = yield* makeAdapter(defaultClient({
        getPageVersions: () =>
          Effect.succeed({
            results: [currentPage.version],
            _links: { next: "/versions?cursor=repeated" }
          })
      }))
      const cursor = yield* cursorAdapter.connection.readEntity(request).pipe(Effect.result)
      assert.isTrue(Result.isFailure(cursor))
      if (Result.isFailure(cursor)) {
        assert.strictEqual(cursor.failure._tag, "PluginMalformedResponseFailure")
        if (cursor.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(cursor.failure.diagnosticCode, "confluence-version-cursor-loop")
        }
      }
    }))

  it.effect("maps the narrow client failure taxonomy into plugin failures", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-read",
              reason: "authorization",
              retryAfterSeconds: null
            })
          )
      }))
      const outcome = yield* adapter.connection.readEntity(request).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "PluginAuthorizationFailure")
    }))

  it.effect("maps provider conflicts consistently across read and governed proposal paths", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-read",
              reason: "conflict",
              retryAfterSeconds: null
            })
          )
      }))
      const read = yield* adapter.connection.readEntity(request).pipe(Effect.exit)
      const proposal = yield* adapter.connection.proposeAction(actionRequest).pipe(Effect.exit)

      expectFailureTag(read, "PluginConflictFailure", "confluence-page-version-conflict")
      expectFailureTag(proposal, "PluginConflictFailure", "confluence-page-version-conflict")
    }))

  it.effect("returns an authoritative missing result for a provider 404", () =>
    Effect.gen(function*() {
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.fail(
            new ConfluencePageClientFailure({
              operation: "confluence-page-read",
              reason: "not-found",
              retryAfterSeconds: null
            })
          )
      }))
      const result = yield* adapter.connection.readEntity(request)

      assert.strictEqual(result._tag, "missing")
      if (result._tag === "missing") assert.deepStrictEqual(result.reference, request)
    }))

  it.effect("returns missing for unrelated entity types without touching Confluence", () =>
    Effect.gen(function*() {
      let calls = 0
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () =>
          Effect.sync(() => {
            calls += 1
            return currentPage
          })
      }))
      const unrelated = Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
        entityType: "jira-issue",
        vendorImmutableId: "PAY-42"
      })
      const result = yield* adapter.connection.readEntity(unrelated)

      assert.strictEqual(result._tag, "missing")
      assert.strictEqual(calls, 0)
    }))

  it.effect("propagates interruption through an in-flight provider read", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<unknown>()
      const adapter = yield* makeAdapter(defaultClient({
        getPage: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      }))
      const fiber = yield* adapter.connection.readEntity(request).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
    }).pipe(Effect.scoped))
})
