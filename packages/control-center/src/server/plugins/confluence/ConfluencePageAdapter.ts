/**
 * Production Confluence page-read normalization for the Control Center plugin contract.
 *
 * This slice deliberately offers only `entity.read`. Provider writes, sync,
 * attachments, watchers, and activity stay unadvertised until their complete
 * contracts and recovery behavior exist.
 *
 * @module
 */
import { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Stream from "effect/Stream"

import type { PluginHealth } from "../../../domain/freshness.js"
import {
  hasMaximumPluginJsonBytes,
  MaximumPluginPayloadBytes,
  type NegotiatedPluginDescriptorV1,
  ReadPluginEntityResultV1,
  type ReadPluginEntityResultV1 as ReadPluginEntityResultV1Type
} from "../../../domain/plugins/index.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import {
  ConfluencePageClient,
  type ConfluencePageClientFailure,
  type ConfluencePageClientShape
} from "./ConfluencePageClient.js"
import {
  ConfluencePageAttributesV1,
  RawConfluenceCurrentUser,
  RawConfluencePage,
  type RawConfluenceUser,
  RawConfluenceUsers,
  type RawConfluenceVersion,
  RawConfluenceVersionPage,
  type RawConfluenceVersionPage as RawConfluenceVersionPageType
} from "./ConfluencePageSchemas.js"
import { toSafeConfluenceMarkdown } from "./SafeConfluenceMarkdown.js"

const MAXIMUM_VERSION_PAGES = 5
const MAXIMUM_USERS_PER_REQUEST = 250
const ConfluencePageEntityType = "confluence-page"

const SiteUrl = Schema.String.pipe(
  Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString),
  Schema.check(
    Schema.makeFilter(
      ({ hostname, pathname, port, protocol }) =>
        protocol === "https:" &&
        hostname.endsWith(".atlassian.net") &&
        hostname.length > ".atlassian.net".length &&
        port.length === 0 &&
        pathname === "/",
      { expected: "an HTTPS Confluence Cloud tenant root URL under atlassian.net" }
    ),
    Schema.makeFilter(({ password, username }) => password.length === 0 && username.length === 0, {
      expected: "a Confluence site URL without embedded credentials"
    }),
    Schema.makeFilter(({ hash, search }) => hash.length === 0 && search.length === 0, {
      expected: "a Confluence site URL without query parameters or fragments"
    })
  )
)
const Identifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const BoundedNormalizedAttributes = Schema.Json.check(
  hasMaximumPluginJsonBytes(MaximumPluginPayloadBytes)
)

/** Secret-free configuration consumed after a registry has constructed the authenticated client. @internal */
export const ConfluencePageAdapterConfiguration = Schema.Struct({
  siteBaseUrl: SiteUrl,
  siteId: Identifier,
  spaceId: Identifier,
  probePageId: Identifier
})

/** Decoded Confluence page adapter configuration. @internal */
export type ConfluencePageAdapterConfiguration = typeof ConfluencePageAdapterConfiguration.Type

/** @internal */
export interface MakeConfluencePageAdapterInput {
  readonly client: ConfluencePageClientShape
  readonly configuration: ConfluencePageAdapterConfiguration
  readonly converter: MarkdownConverter["Service"]
  readonly descriptor: NegotiatedPluginDescriptorV1
}

const malformed = (operation: string, diagnosticCode: string): PluginMalformedResponseFailure =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const decodeProvider = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  diagnosticCode: string,
  schema: S,
  input: unknown
): Effect.Effect<S["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => malformed(operation, diagnosticCode))
  )

const decodeScopedPage = Effect.fn("ConfluencePage.decodeScopedPage")(function*(
  operation: string,
  invalidDiagnosticCode: string,
  rawPage: unknown,
  expectedPageId: string,
  expectedSpaceId: string
) {
  const page = yield* decodeProvider(
    operation,
    invalidDiagnosticCode,
    RawConfluencePage,
    rawPage
  )
  if (page.id !== expectedPageId) {
    return yield* malformed(operation, "confluence-page-identity-mismatch")
  }
  if (page.spaceId !== expectedSpaceId) {
    return yield* malformed(operation, "confluence-page-space-mismatch")
  }
  return page
})

const toPluginFailure = Effect.fn("ConfluencePage.toPluginFailure")(function*(
  failure: ConfluencePageClientFailure
): Effect.fn.Return<PluginFailure> {
  switch (failure.reason) {
    case "authentication":
      return new PluginAuthenticationFailure({ operation: failure.operation })
    case "authorization":
      return new PluginAuthorizationFailure({ operation: failure.operation })
    case "not-found":
      return new PluginOutageFailure({ operation: failure.operation })
    case "timeout":
      return new PluginTimeoutFailure({ operation: failure.operation })
    case "malformed-response":
      return malformed(failure.operation, "confluence-wire-response-invalid")
    case "outage":
      return new PluginOutageFailure({ operation: failure.operation })
    case "rate-limit": {
      const now = yield* DateTime.now
      const retryAt = DateTime.add(now, { seconds: failure.retryAfterSeconds ?? 1 })
      return new PluginRateLimitFailure({ operation: failure.operation, retryAt })
    }
  }
})

const providerCall = <Value>(
  effect: Effect.Effect<Value, ConfluencePageClientFailure>
): Effect.Effect<Value, PluginFailure> =>
  effect.pipe(
    Effect.catchTag("ConfluencePageClientFailure", (failure) =>
      toPluginFailure(failure).pipe(Effect.flatMap(Effect.fail)))
  )

const nextCursor = (
  page: RawConfluenceVersionPageType
): Effect.Effect<string | null, PluginMalformedResponseFailure> => {
  const next = page._links?.next
  if (next === undefined) return Effect.succeed(null)
  const encoded = /(?:[?&])cursor=([^&#]+)/u.exec(next)?.[1]
  if (encoded === undefined) {
    return Effect.fail(malformed("confluence-page-versions", "confluence-version-cursor-missing"))
  }
  return Effect.try({
    try: () => decodeURIComponent(encoded),
    catch: () => malformed("confluence-page-versions", "confluence-version-cursor-invalid")
  }).pipe(
    Effect.flatMap((cursor) =>
      cursor.length > 0 && cursor.length <= 2_048
        ? Effect.succeed(cursor)
        : Effect.fail(malformed("confluence-page-versions", "confluence-version-cursor-invalid"))
    )
  )
}

const readVersions = Effect.fn("ConfluencePage.readVersions")(function*(
  client: ConfluencePageClientShape,
  pageId: string
) {
  const versions: Array<RawConfluenceVersion> = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let pagesFetched = 0
  let complete = false
  while (pagesFetched < MAXIMUM_VERSION_PAGES) {
    const raw: unknown = yield* providerCall(client.getPageVersions(pageId, cursor))
    const page: RawConfluenceVersionPageType = yield* decodeProvider(
      "confluence-page-versions",
      "confluence-version-page-invalid",
      RawConfluenceVersionPage,
      raw
    )
    for (const version of page.results ?? []) versions.push(version)
    pagesFetched += 1
    const following: string | null = yield* nextCursor(page)
    if (following === null) {
      complete = true
      break
    }
    if (seenCursors.has(following)) {
      return yield* malformed("confluence-page-versions", "confluence-version-cursor-loop")
    }
    seenCursors.add(following)
    cursor = following
  }
  return { complete, pagesFetched, versions }
})

const chunksOf = <Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> => {
  const chunks: Array<ReadonlyArray<Value>> = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}

const readUsers = Effect.fn("ConfluencePage.readUsers")(function*(
  client: ConfluencePageClientShape,
  accountIds: ReadonlyArray<string>
) {
  const users = new Map<string, RawConfluenceUser>()
  for (const batch of chunksOf(accountIds, MAXIMUM_USERS_PER_REQUEST)) {
    if (batch.length === 0) continue
    const raw = yield* providerCall(client.getUsers(batch)).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PluginAuthorizationFailure", () => Effect.succeed(Option.none<unknown>()))
    )
    if (Option.isNone(raw)) return new Map<string, RawConfluenceUser>()
    const response = yield* decodeProvider(
      "confluence-user-lookup",
      "confluence-user-page-invalid",
      RawConfluenceUsers,
      raw.value
    )
    for (const user of response.results ?? []) users.set(user.accountId, user)
  }
  return users
})

type ContributorRole = "owner" | "author" | "contributor"
const roleOrder: ReadonlyArray<ContributorRole> = ["owner", "author", "contributor"]

const normalizedContributors = Effect.fn("ConfluencePage.normalizeContributors")(function*(
  client: ConfluencePageClientShape,
  page: typeof RawConfluencePage.Type,
  versions: ReadonlyArray<RawConfluenceVersion>
) {
  const roles = new Map<string, Set<ContributorRole>>()
  const addRole = (accountId: string | undefined | null, role: ContributorRole): void => {
    if (accountId === undefined || accountId === null) return
    const current = roles.get(accountId) ?? new Set<ContributorRole>()
    current.add(role)
    roles.set(accountId, current)
  }
  addRole(page.ownerId, "owner")
  addRole(page.version.authorId, "author")
  for (const version of versions) addRole(version.authorId, "contributor")
  const accountIds = [...roles.keys()].sort()
  const users = yield* readUsers(client, accountIds)
  return accountIds.map((accountId) => {
    const user = users.get(accountId)
    const resolved = user?.accountStatus !== undefined && user.accountStatus !== "unknown"
    return {
      accountId,
      displayName: user?.displayName ?? accountId,
      active: resolved && user.accountStatus === "active",
      external: user?.isExternalCollaborator ?? false,
      resolved,
      roles: roleOrder.filter((role) => roles.get(accountId)?.has(role) ?? false)
    }
  })
})

const sourceUrl = (
  siteBaseUrl: URL,
  webui: string | undefined
): string | null => {
  if (webui === undefined) return null
  const candidate = Result.try(() => new URL(webui, siteBaseUrl))
  if (Result.isFailure(candidate) || candidate.success.origin !== siteBaseUrl.origin) return null
  if (candidate.success.username.length > 0 || candidate.success.password.length > 0) return null
  return candidate.success.toString()
}

const readPageEntity = Effect.fn("ConfluencePage.readEntity")(function*(
  input: MakeConfluencePageAdapterInput,
  pageId: string
): Effect.fn.Return<ReadPluginEntityResultV1Type, PluginFailure> {
  const pageRead = yield* input.client.getPage(pageId).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ConfluencePageClientFailure", (failure) =>
      failure.reason === "not-found"
        ? Effect.succeed(Option.none<unknown>())
        : toPluginFailure(failure).pipe(Effect.flatMap(Effect.fail)))
  )
  if (Option.isNone(pageRead)) {
    const observedAt = yield* DateTime.now
    return yield* decodeProvider(
      "confluence-page-normalization",
      "confluence-normalized-missing-invalid",
      ReadPluginEntityResultV1,
      {
        _tag: "missing",
        reference: { entityType: ConfluencePageEntityType, vendorImmutableId: pageId },
        observedAt: DateTime.formatIso(observedAt)
      }
    )
  }
  const page = yield* decodeScopedPage(
    "confluence-page-read",
    "confluence-page-invalid",
    pageRead.value,
    pageId,
    input.configuration.spaceId
  )
  const history = yield* readVersions(input.client, pageId)
  const contributors = yield* normalizedContributors(input.client, page, history.versions)
  const adf = page.body?.atlas_doc_format?.value
  const markdown = adf === undefined
    ? null
    : yield* toSafeConfluenceMarkdown(input.converter, adf)
  const attributesInput = {
    schemaVersion: 1,
    status: page.status,
    spaceId: page.spaceId,
    parentId: page.parentId ?? null,
    createdAt: page.createdAt,
    updatedAt: page.version.createdAt,
    currentVersion: page.version.number,
    content: markdown === null ? null : { representation: "safe-markdown", markdown },
    versions: history.versions.map((version) => ({
      number: version.number,
      createdAt: version.createdAt,
      message: version.message ?? null,
      minorEdit: version.minorEdit ?? false,
      authorId: version.authorId ?? null
    })),
    versionHistory: {
      complete: history.complete,
      pagesFetched: history.pagesFetched
    },
    contributors
  }
  yield* decodeProvider(
    "confluence-page-normalization",
    "confluence-content-too-large",
    BoundedNormalizedAttributes,
    attributesInput
  )
  const attributes = yield* decodeProvider(
    "confluence-page-normalization",
    "confluence-normalized-page-invalid",
    ConfluencePageAttributesV1,
    attributesInput
  )
  const observedAt = yield* DateTime.now
  return yield* decodeProvider(
    "confluence-page-normalization",
    "confluence-normalized-event-invalid",
    ReadPluginEntityResultV1,
    {
      _tag: "found",
      event: {
        _tag: "UpsertEntity",
        eventId: `confluence-page:${page.id}:v${page.version.number}`,
        observedAt: DateTime.formatIso(observedAt),
        revision: String(page.version.number),
        entityType: ConfluencePageEntityType,
        vendorImmutableId: page.id,
        sourceUrl: sourceUrl(input.configuration.siteBaseUrl, page._links?.webui),
        title: page.title,
        attributes
      }
    }
  )
})

const unsupported = (capabilityId: "action.execute" | "action.cancel" | "action.reconcile") =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "confluence-read-adapter-capability-unavailable"
  })

const currentUserDisplayName = (displayName: string | null | undefined, publicName: string | undefined): string => {
  for (const candidate of [displayName, publicName]) {
    const normalized = candidate?.trim()
    if (normalized !== undefined && normalized.length > 0) return normalized
  }
  return "Confluence user"
}

/** Construct the page-read adapter against an authenticated, scoped client. @internal */
export const makeConfluencePageAdapter = (
  input: MakeConfluencePageAdapterInput
): {
  readonly connection: PluginConnectionV1
  readonly executor: AuthorizedPluginExecutorV1
} => {
  const connection: PluginConnectionV1 = {
    descriptor: input.descriptor,
    discover: Effect.gen(function*() {
      const discoveredAt = yield* DateTime.now
      const rawUser = yield* providerCall(input.client.getCurrentUser)
      const user = yield* decodeProvider(
        "confluence-current-user",
        "confluence-current-user-invalid",
        RawConfluenceCurrentUser,
        rawUser
      )
      const endpoint = yield* Schema.decodeUnknownEffect(SourceUrl)(
        new URL("/wiki/api/v2", input.configuration.siteBaseUrl).toString()
      ).pipe(Effect.mapError(() => malformed("confluence-discover", "confluence-endpoint-invalid")))
      return {
        account: {
          providerImmutableId: user.accountId,
          displayName: currentUserDisplayName(user.displayName, user.publicName)
        },
        workspace: {
          providerImmutableId: input.configuration.siteId,
          displayName: input.configuration.siteBaseUrl.hostname
        },
        resource: {
          providerImmutableId: input.configuration.spaceId,
          displayName: `Space · ${input.configuration.spaceId}`
        },
        endpoints: [{ kind: "api", url: endpoint, label: "Confluence Cloud v2" }],
        discoveredAt
      }
    }),
    health: providerCall(input.client.getPage(input.configuration.probePageId)).pipe(
      Effect.flatMap((page) =>
        decodeScopedPage(
          "confluence-health",
          "confluence-health-page-invalid",
          page,
          input.configuration.probePageId,
          input.configuration.spaceId
        )
      ),
      Effect.andThen(DateTime.now),
      Effect.map((checkedAt): PluginHealth => ({ _tag: "healthy", checkedAt }))
    ),
    sync: () =>
      Stream.fail(
        new PluginUnsupportedCapabilityFailure({
          capabilityId: "sync.incremental",
          requestedVersion: 1,
          diagnosticCode: "confluence-read-adapter-capability-unavailable"
        })
      ),
    readEntity: (request) =>
      request.entityType === ConfluencePageEntityType
        ? readPageEntity(input, request.vendorImmutableId)
        : DateTime.now.pipe(Effect.map((observedAt) => ({ _tag: "missing", reference: request, observedAt }))),
    diff: Option.none(),
    proposeAction: () =>
      Effect.fail(
        new PluginUnsupportedCapabilityFailure({
          capabilityId: "action.propose",
          requestedVersion: 1,
          diagnosticCode: "confluence-read-adapter-capability-unavailable"
        })
      )
  }
  const executor: AuthorizedPluginExecutorV1 = {
    preflight: () => Effect.fail(unsupported("action.execute")),
    executeAuthorizedAction: () => Effect.fail(unsupported("action.execute")),
    requestCancellation: () => Effect.fail(unsupported("action.cancel")),
    reconcile: () => Effect.fail(unsupported("action.reconcile"))
  }
  return { connection, executor }
}

/** Acquire the adapter dependencies from a future scoped runtime registry. @internal */
export const acquireConfluencePageAdapter = Effect.fn("ConfluencePage.acquireAdapter")(function*(
  configuration: ConfluencePageAdapterConfiguration,
  descriptor: NegotiatedPluginDescriptorV1
) {
  const client = yield* ConfluencePageClient
  const converter = yield* MarkdownConverter
  return makeConfluencePageAdapter({ client, configuration, converter, descriptor })
})
