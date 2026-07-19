import { assert, describe, it } from "@effect/vitest"
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { MaximumPluginPayloadBytes, ReadPluginEntityRequestV1 } from "../../src/domain/plugins/index.js"
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

const converter = (
  markdown = "Runbook\n",
  onConvert: () => void = () => undefined
): MarkdownConverter["Service"] => ({
  adfToMarkdown: () =>
    Effect.sync(() => {
      onConvert()
      return markdown
    }),
  markdownToAdf: (value) => Effect.succeed(value)
})

const defaultClient = (overrides: Partial<ConfluencePageClientShape> = {}): ConfluencePageClientShape => ({
  getCurrentUser: Effect.succeed({
    accountId: "account-current-user",
    displayName: "Avery Bell",
    accountStatus: "active"
  }),
  getSystemInfo: Effect.succeed({ cloudId: "site-acme", commitHash: "commit", siteTitle: "Acme" }),
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
  markdown?: string,
  onConvert?: () => void,
  configured: ConfluencePageAdapterConfiguration = configuration
) {
  const descriptor = yield* negotiatePluginDescriptorV1(confluencePagePluginDescriptor)
  return makeConfluencePageAdapter({
    client,
    configuration: configured,
    converter: converter(markdown, onConvert),
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

describe("Confluence page adapter", () => {
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
