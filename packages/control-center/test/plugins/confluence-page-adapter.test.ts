import { assert, describe, it } from "@effect/vitest"
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { ReadPluginEntityRequestV1 } from "../../src/domain/plugins/index.js"
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

const PAGE_ID = "page-42"
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

const converter = (markdown = "Runbook\n"): MarkdownConverter["Service"] => ({
  adfToMarkdown: () => Effect.succeed(markdown),
  markdownToAdf: (value) => Effect.succeed(value)
})

const defaultClient = (overrides: Partial<ConfluencePageClientShape> = {}): ConfluencePageClientShape => ({
  getPage: () => Effect.succeed(currentPage),
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
  markdown?: string
) {
  const descriptor = yield* negotiatePluginDescriptorV1(confluencePagePluginDescriptor)
  return makeConfluencePageAdapter({
    client,
    configuration,
    converter: converter(markdown),
    descriptor
  })
})

describe("Confluence page adapter", () => {
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
