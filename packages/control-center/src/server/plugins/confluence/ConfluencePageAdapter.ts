/**
 * Production Confluence page-read normalization for the Control Center plugin contract.
 *
 * This slice offers lazy `entity.read` plus bounded space-page synchronization.
 * Provider writes, attachment bytes, watchers, and unbounded activity stay
 * unadvertised until their complete contracts and recovery behavior exist.
 *
 * @module
 */
import { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
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
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  ReadPluginEntityResultV1,
  type ReadPluginEntityResultV1 as ReadPluginEntityResultV1Type
} from "../../../domain/plugins/index.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
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
  RawConfluenceAttachmentPage,
  type RawConfluenceAttachmentPage as RawConfluenceAttachmentPageType,
  RawConfluenceCurrentUser,
  RawConfluencePage,
  RawConfluenceSpacePage,
  type RawConfluenceSpacePage as RawConfluenceSpacePageType,
  type RawConfluenceUser,
  RawConfluenceUsers,
  type RawConfluenceVersion,
  RawConfluenceVersionPage,
  type RawConfluenceVersionPage as RawConfluenceVersionPageType,
  RawConfluenceWatcherPage,
  type RawConfluenceWatcherPage as RawConfluenceWatcherPageType
} from "./ConfluencePageSchemas.js"
import { toSafeConfluenceMarkdown } from "./SafeConfluenceMarkdown.js"

const MAXIMUM_VERSION_PAGES = 5
const MAXIMUM_ATTACHMENT_PAGES = 2
const MAXIMUM_WATCHER_PAGES = 2
const MAXIMUM_SPACE_PAGES_PER_SYNC = 5
const MAXIMUM_USERS_PER_REQUEST = 250
const MAXIMUM_CONTRIBUTORS = 502
const MAXIMUM_CHECKPOINT_LENGTH = 2_048
const ConfluencePageEntityType = "confluence-page"
const CONFLUENCE_PAGE_STREAM_KEY = "pages"
const LEGACY_COMPLETE_CHECKPOINT = "complete"
const COMPLETE_CHECKPOINT_PREFIX = "complete:"
const NEXT_CHECKPOINT_PREFIX = "next:"
const BOUNDED_CHECKPOINT_PREFIX = "bounded:"
const DURABLE_BOUNDED_CHECKPOINT_PREFIX = "bounded:v1:"
const DURABLE_COMPLETE_CHECKPOINT_PREFIX = "complete:v1:"
const RESTART_INITIAL_CHECKPOINT = "restart:initial"
const RESTART_CURSOR_PREFIX = "restart:cursor:"
const INVENTORY_DIGEST_LENGTH = 64
const MAXIMUM_SYNC_CURSOR_LENGTH = MAXIMUM_CHECKPOINT_LENGTH
  - DURABLE_COMPLETE_CHECKPOINT_PREFIX.length
  - INVENTORY_DIGEST_LENGTH
  - 1
  - INVENTORY_DIGEST_LENGTH
  - 1

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
const RawConfluenceSystemInfo = Schema.Struct({
  cloudId: Identifier,
  siteTitle: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)))
})
const BoundedNormalizedAttributes = Schema.Json.check(
  hasMaximumPluginJsonBytes(MaximumPluginPayloadBytes)
)

/** Secret-free configuration consumed after a registry has constructed the authenticated client. @internal */
export const ConfluencePageAdapterConfiguration = Schema.Struct({
  siteBaseUrl: SiteUrl,
  siteId: Identifier,
  spaceId: Identifier,
  probePageId: Identifier,
  oauthVerifiedSiteId: Schema.optionalKey(Identifier)
})

/** Decoded Confluence page adapter configuration. @internal */
export type ConfluencePageAdapterConfiguration = typeof ConfluencePageAdapterConfiguration.Type

/** @internal */
export interface MakeConfluencePageAdapterInput {
  readonly client: ConfluencePageClientShape
  readonly configuration: ConfluencePageAdapterConfiguration
  readonly converter: MarkdownConverter["Service"]
  readonly cryptoService: Crypto.Crypto
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

const cursorFromNextLink = (
  operation: string,
  diagnosticCode: string,
  next: string | undefined,
  maximumLength = MAXIMUM_CHECKPOINT_LENGTH
): Effect.Effect<string | null, PluginMalformedResponseFailure> => {
  if (next === undefined) return Effect.succeed(null)
  const encoded = /(?:[?&])cursor=([^&#]+)/u.exec(next)?.[1]
  if (encoded === undefined) return Effect.fail(malformed(operation, `${diagnosticCode}-missing`))
  return Effect.try({
    try: () => decodeURIComponent(encoded),
    catch: () => malformed(operation, `${diagnosticCode}-invalid`)
  }).pipe(
    Effect.flatMap((cursor) =>
      cursor.length > 0 && cursor.length <= maximumLength
        ? Effect.succeed(cursor)
        : Effect.fail(malformed(operation, `${diagnosticCode}-invalid`))
    )
  )
}

interface BoundedPrefixCheckpoint {
  readonly cursor: string
  readonly inventoryDigest: string
}

interface SyncCheckpointState {
  readonly boundedPrefix: BoundedPrefixCheckpoint | null
  readonly cursor: string | null
  readonly inventoryDigest: string | null
}

const initialSyncCheckpointState: SyncCheckpointState = {
  boundedPrefix: null,
  cursor: null,
  inventoryDigest: null
}

const validSyncCursor = (cursor: string): boolean => cursor.length > 0 && cursor.length <= MAXIMUM_SYNC_CURSOR_LENGTH

const syncCursorFromCheckpoint = (
  checkpoint: PluginSyncRequestV1["checkpoint"]
): Effect.Effect<SyncCheckpointState, PluginConfigurationFailure> => {
  if (checkpoint === null || checkpoint === LEGACY_COMPLETE_CHECKPOINT) {
    return Effect.succeed(initialSyncCheckpointState)
  }
  if (checkpoint.startsWith(DURABLE_COMPLETE_CHECKPOINT_PREFIX)) {
    const match = /^([0-9a-f]{64}):([0-9a-f]{64}):(.+)$/u.exec(
      checkpoint.slice(DURABLE_COMPLETE_CHECKPOINT_PREFIX.length)
    )
    if (match !== null && validSyncCursor(match[3] ?? "")) {
      const boundedPrefix = { inventoryDigest: match[2]!, cursor: match[3]! }
      return Effect.succeed({
        boundedPrefix,
        cursor: boundedPrefix.cursor,
        inventoryDigest: boundedPrefix.inventoryDigest
      })
    }
    return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-checkpoint-invalid" }))
  }
  if (checkpoint.startsWith(COMPLETE_CHECKPOINT_PREFIX)) {
    return /^[0-9a-f]{64}$/u.test(checkpoint.slice(COMPLETE_CHECKPOINT_PREFIX.length))
      ? Effect.succeed(initialSyncCheckpointState)
      : Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-checkpoint-invalid" }))
  }
  if (checkpoint.startsWith(DURABLE_BOUNDED_CHECKPOINT_PREFIX)) {
    const match = /^([0-9a-f]{64}):(.+)$/u.exec(
      checkpoint.slice(DURABLE_BOUNDED_CHECKPOINT_PREFIX.length)
    )
    if (match !== null && validSyncCursor(match[2] ?? "")) {
      const boundedPrefix = { inventoryDigest: match[1]!, cursor: match[2]! }
      return Effect.succeed({
        boundedPrefix,
        cursor: boundedPrefix.cursor,
        inventoryDigest: boundedPrefix.inventoryDigest
      })
    }
    return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-checkpoint-invalid" }))
  }
  if (checkpoint === RESTART_INITIAL_CHECKPOINT) return Effect.succeed(initialSyncCheckpointState)
  for (const prefix of [NEXT_CHECKPOINT_PREFIX, BOUNDED_CHECKPOINT_PREFIX, RESTART_CURSOR_PREFIX]) {
    if (!checkpoint.startsWith(prefix)) continue
    const cursor = checkpoint.slice(prefix.length)
    return validSyncCursor(cursor)
      ? Effect.succeed({ boundedPrefix: null, cursor, inventoryDigest: null })
      : Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-checkpoint-invalid" }))
  }
  return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-checkpoint-invalid" }))
}

const checkpointAfterPage = (
  cursor: string | null,
  bounded: boolean,
  inventoryDigest: string,
  previousBoundedPrefix: BoundedPrefixCheckpoint | null
): string => {
  if (cursor !== null) {
    return bounded
      ? `${DURABLE_BOUNDED_CHECKPOINT_PREFIX}${inventoryDigest}:${cursor}`
      : `${NEXT_CHECKPOINT_PREFIX}${cursor}`
  }
  return previousBoundedPrefix === null
    ? `${COMPLETE_CHECKPOINT_PREFIX}${inventoryDigest}`
    : `${DURABLE_COMPLETE_CHECKPOINT_PREFIX}${inventoryDigest}:${previousBoundedPrefix.inventoryDigest}:${previousBoundedPrefix.cursor}`
}

const checkpointBeforePage = (cursor: string | null): string =>
  cursor === null ? RESTART_INITIAL_CHECKPOINT : `${RESTART_CURSOR_PREFIX}${cursor}`

const jsonByteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const digestSyncIdentity = Effect.fn("ConfluencePage.digestSyncIdentity")(function*(
  cryptoService: Crypto.Crypto,
  value: unknown
) {
  const serialized = JSON.stringify(value)
  const bytes = yield* Effect.fromResult(
    Encoding.decodeBase64(Encoding.encodeBase64(serialized))
  ).pipe(
    Effect.mapError(() => new PluginOutageFailure({ operation: "confluence-sync-identity" }))
  )
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => new PluginOutageFailure({ operation: "confluence-sync-identity" }))
  )
  return Encoding.encodeHex(digest)
})

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

type ContributorRole = "owner" | "author" | "contributor" | "watcher"
const roleOrder: ReadonlyArray<ContributorRole> = ["owner", "author", "contributor", "watcher"]

const contributorRoles = (
  page: typeof RawConfluencePage.Type,
  versions: ReadonlyArray<RawConfluenceVersion>
): Map<string, Set<ContributorRole>> => {
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
  return roles
}

const contributorsFromUsers = (
  roles: ReadonlyMap<string, ReadonlySet<ContributorRole>>,
  users: ReadonlyMap<string, RawConfluenceUser>
) => {
  const accountIds = [...roles.keys()].sort()
  return accountIds.map((accountId) => {
    const user = users.get(accountId)
    const resolved = user?.displayName !== undefined &&
      user.displayName !== null &&
      user.accountStatus !== undefined &&
      user.accountStatus !== "unknown"
    return {
      accountId,
      displayName: user?.displayName ?? "Confluence user",
      active: resolved && user.accountStatus === "active",
      external: user?.isExternalCollaborator ?? false,
      resolved,
      roles: roleOrder.filter((role) => roles.get(accountId)?.has(role) ?? false)
    }
  })
}

const normalizedContributors = Effect.fn("ConfluencePage.normalizeContributors")(function*(
  client: ConfluencePageClientShape,
  page: typeof RawConfluencePage.Type,
  versions: ReadonlyArray<RawConfluenceVersion>
) {
  const roles = contributorRoles(page, versions)
  const users = yield* readUsers(client, [...roles.keys()].sort())
  return contributorsFromUsers(roles, users)
})

interface AttachmentInventory {
  readonly attachments: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly createdAt: string
    readonly mediaType: string | null
    readonly fileSize: number | null
    readonly version: number | null
  }>
  readonly complete: boolean
  readonly pagesFetched: number
}

interface WatcherInventory {
  readonly accountIds: ReadonlyArray<string>
  readonly complete: boolean
  readonly pagesFetched: number
}

interface NormalizedVersion {
  readonly number: number
  readonly createdAt: string
  readonly message: string | null
  readonly minorEdit: boolean
  readonly authorId: string | null
}

interface SyncAttributesInput {
  readonly schemaVersion: 1
  readonly status: "current"
  readonly spaceId: string
  readonly parentId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly currentVersion: number
  readonly content: null
  readonly contentState: "lazy"
  readonly versions: ReadonlyArray<NormalizedVersion>
  readonly versionHistory: { readonly complete: boolean; readonly pagesFetched: number }
  readonly contributors: ReturnType<typeof contributorsFromUsers>
  readonly attachments: AttachmentInventory["attachments"]
  readonly attachmentInventory: { readonly complete: boolean; readonly pagesFetched: number }
  readonly watcherInventory: { readonly complete: boolean; readonly pagesFetched: number }
}

const fitSyncAttributes = (attributes: SyncAttributesInput): SyncAttributesInput => {
  if (jsonByteLength(attributes) <= MaximumPluginPayloadBytes) return attributes
  const versions: Array<NormalizedVersion> = attributes.versions.map((version) => ({
    ...version,
    message: null
  }))
  const contributors = [...attributes.contributors]
  const attachments = [...attributes.attachments]
  let compacted: SyncAttributesInput = {
    ...attributes,
    versions,
    contributors,
    attachments,
    versionHistory: { ...attributes.versionHistory, complete: false }
  }
  let compactedBytes = jsonByteLength(compacted)

  while (compactedBytes > MaximumPluginPayloadBytes && versions.length > 0) {
    let historicalIndex = -1
    for (let index = versions.length - 1; index >= 0; index--) {
      if (versions[index]?.number !== attributes.currentVersion) {
        historicalIndex = index
        break
      }
    }
    const [removed] = versions.splice(historicalIndex >= 0 ? historicalIndex : versions.length - 1, 1)
    if (removed === undefined) break
    compactedBytes -= jsonByteLength(removed) + (versions.length > 0 ? 1 : 0)
  }
  while (compactedBytes > MaximumPluginPayloadBytes && contributors.length > 0) {
    let lowerPriorityIndex = -1
    for (let index = contributors.length - 1; index >= 0; index--) {
      const contributor = contributors[index]
      if (contributor !== undefined && !contributor.roles.includes("owner") && !contributor.roles.includes("author")) {
        lowerPriorityIndex = index
        break
      }
    }
    const [removed] = contributors.splice(
      lowerPriorityIndex >= 0 ? lowerPriorityIndex : contributors.length - 1,
      1
    )
    if (removed === undefined) break
    compactedBytes -= jsonByteLength(removed) + (contributors.length > 0 ? 1 : 0)
    if (removed.roles.includes("watcher")) {
      if (compacted.watcherInventory.complete) compactedBytes += 1
      compacted = {
        ...compacted,
        watcherInventory: { ...compacted.watcherInventory, complete: false }
      }
    }
  }
  while (compactedBytes > MaximumPluginPayloadBytes && attachments.length > 0) {
    const removed = attachments.pop()
    if (removed === undefined) break
    compactedBytes -= jsonByteLength(removed) + (attachments.length > 0 ? 1 : 0)
    if (compacted.attachmentInventory.complete) compactedBytes += 1
    compacted = {
      ...compacted,
      attachmentInventory: { ...compacted.attachmentInventory, complete: false }
    }
  }
  return compacted
}

const readWatcherInventory = Effect.fn("ConfluencePage.readWatcherInventory")(function*(
  client: ConfluencePageClientShape,
  pageId: string
): Effect.fn.Return<WatcherInventory, PluginFailure> {
  const accountIds = new Set<string>()
  let allWatcherIdentitiesVisible = true
  let pagesFetched = 0
  let start = 0
  const numericPageId = Number(pageId)
  const pageIdCanBeComparedExactly = Number.isSafeInteger(numericPageId) && String(numericPageId) === pageId
  while (pagesFetched < MAXIMUM_WATCHER_PAGES) {
    const loaded = yield* providerCall(client.getPageWatchers(pageId, start)).pipe(Effect.result)
    if (Result.isFailure(loaded)) {
      if (loaded.failure._tag === "PluginAuthorizationFailure") {
        return { accountIds: [...accountIds], complete: false, pagesFetched }
      }
      return yield* loaded.failure
    }
    const page: RawConfluenceWatcherPageType = yield* decodeProvider(
      "confluence-page-watchers",
      "confluence-watcher-page-invalid",
      RawConfluenceWatcherPage,
      loaded.success
    )
    if (page.start !== start || page.size !== page.results.length || page.size > page.limit) {
      return yield* malformed("confluence-page-watchers", "confluence-watcher-page-inconsistent")
    }
    for (const { contentId, watcher } of page.results) {
      if (!pageIdCanBeComparedExactly) {
        allWatcherIdentitiesVisible = false
        continue
      }
      if (contentId !== numericPageId) {
        return yield* malformed("confluence-page-watchers", "confluence-watcher-page-mismatch")
      }
      if (watcher.accountId === null) {
        allWatcherIdentitiesVisible = false
        continue
      }
      accountIds.add(watcher.accountId)
    }
    pagesFetched += 1
    if (page.size < page.limit) {
      return { accountIds: [...accountIds], complete: allWatcherIdentitiesVisible, pagesFetched }
    }
    start += page.size
  }
  return { accountIds: [...accountIds], complete: false, pagesFetched }
})

const readAttachmentInventory = Effect.fn("ConfluencePage.readAttachmentInventory")(function*(
  client: ConfluencePageClientShape,
  pageId: string
): Effect.fn.Return<AttachmentInventory, PluginFailure> {
  const attachments: Array<AttachmentInventory["attachments"][number]> = []
  const identities = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let pagesFetched = 0

  while (pagesFetched < MAXIMUM_ATTACHMENT_PAGES) {
    const loaded = yield* providerCall(client.getPageAttachments(pageId, cursor)).pipe(Effect.result)
    if (Result.isFailure(loaded)) {
      if (loaded.failure._tag === "PluginAuthorizationFailure") {
        return { attachments, complete: false, pagesFetched }
      }
      return yield* loaded.failure
    }
    const page: RawConfluenceAttachmentPageType = yield* decodeProvider(
      "confluence-page-attachments",
      "confluence-attachment-page-invalid",
      RawConfluenceAttachmentPage,
      loaded.success
    )
    pagesFetched += 1
    for (const attachment of page.results ?? []) {
      if (attachment.pageId !== pageId) {
        return yield* malformed("confluence-page-attachments", "confluence-attachment-page-mismatch")
      }
      if (identities.has(attachment.id)) {
        return yield* malformed("confluence-page-attachments", "confluence-attachment-identity-duplicate")
      }
      identities.add(attachment.id)
      attachments.push({
        id: attachment.id,
        title: attachment.title,
        createdAt: attachment.createdAt,
        mediaType: attachment.mediaType ?? null,
        fileSize: attachment.fileSize ?? null,
        version: attachment.version?.number ?? null
      })
    }
    const following = yield* cursorFromNextLink(
      "confluence-page-attachments",
      "confluence-attachment-cursor",
      page._links?.next
    )
    if (following === null) return { attachments, complete: true, pagesFetched }
    if (seenCursors.has(following)) {
      return yield* malformed("confluence-page-attachments", "confluence-attachment-cursor-loop")
    }
    seenCursors.add(following)
    cursor = following
  }

  return { attachments, complete: false, pagesFetched }
})

const isRunbookCandidate = (title: string): boolean => /\b(?:runbook|playbook|rollback|operations?)\b/iu.test(title)

const normalizeSyncEvents = Effect.fn("ConfluencePage.normalizeSyncEvents")(function*(
  input: MakeConfluencePageAdapterInput,
  pages: ReadonlyArray<typeof RawConfluencePage.Type>
) {
  for (const page of pages) {
    if (page.spaceId !== input.configuration.spaceId) {
      return yield* malformed("confluence-space-pages", "confluence-page-space-mismatch")
    }
  }
  const contexts = yield* Effect.forEach(
    pages,
    Effect.fn("ConfluencePage.readSyncContext")(function*(page) {
      const { history, inventory, watchers } = yield* Effect.all({
        history: readVersions(input.client, page.id),
        inventory: readAttachmentInventory(input.client, page.id),
        watchers: readWatcherInventory(input.client, page.id)
      }, { concurrency: 3 })
      const hasCurrentVersion = history.versions.some(({ number }) => number === page.version.number)
      const versions = hasCurrentVersion
        ? history.versions
        : [page.version, ...history.versions].slice(0, 500)
      return {
        history: {
          ...history,
          complete: history.complete && (
            hasCurrentVersion || versions.length === history.versions.length + 1
          )
        },
        inventory,
        page,
        versions,
        watchers
      }
    }),
    { concurrency: 4 }
  )
  const rolesByPage = new Map<string, Map<string, Set<ContributorRole>>>()
  const watcherCoverageByPage = new Map<string, boolean>()
  const accountIds = new Set<string>()
  for (const context of contexts) {
    const roles = contributorRoles(context.page, context.versions)
    let allWatchersRetained = true
    for (const accountId of [...context.watchers.accountIds].sort()) {
      if (!roles.has(accountId) && roles.size >= MAXIMUM_CONTRIBUTORS) {
        allWatchersRetained = false
        continue
      }
      const current = roles.get(accountId) ?? new Set<ContributorRole>()
      current.add("watcher")
      roles.set(accountId, current)
    }
    rolesByPage.set(context.page.id, roles)
    watcherCoverageByPage.set(
      context.page.id,
      context.watchers.complete && allWatchersRetained
    )
    for (const accountId of roles.keys()) accountIds.add(accountId)
  }
  const users = yield* readUsers(input.client, [...accountIds].sort())

  const eventGroups = yield* Effect.forEach(
    contexts,
    Effect.fn("ConfluencePage.normalizeSyncPage")(function*(context) {
      const { history, inventory, page, versions, watchers } = context
      const contributors = contributorsFromUsers(rolesByPage.get(page.id) ?? new Map(), users)
      const attributesInput = fitSyncAttributes({
        schemaVersion: 1,
        status: page.status,
        spaceId: page.spaceId,
        parentId: page.parentId ?? null,
        createdAt: page.createdAt,
        updatedAt: page.version.createdAt,
        currentVersion: page.version.number,
        content: null,
        contentState: "lazy",
        versions: versions.map((version) => ({
          number: version.number,
          createdAt: version.createdAt,
          message: version.message ?? null,
          minorEdit: version.minorEdit ?? false,
          authorId: version.authorId ?? null
        })),
        versionHistory: { complete: history.complete, pagesFetched: history.pagesFetched },
        contributors,
        attachments: inventory.attachments,
        attachmentInventory: {
          complete: inventory.complete,
          pagesFetched: inventory.pagesFetched
        },
        watcherInventory: {
          complete: watcherCoverageByPage.get(page.id) ?? false,
          pagesFetched: watchers.pagesFetched
        }
      })
      const attributes = yield* decodeProvider(
        "confluence-sync",
        "confluence-sync-page-attributes-invalid",
        ConfluencePageAttributesV1,
        attributesInput
      )
      const revision = String(page.version.number)
      const observedAt = page.version.createdAt
      const normalizedSourceUrl = sourceUrl(input.configuration.siteBaseUrl, page._links?.webui)
      const identityDigest = yield* digestSyncIdentity(input.cryptoService, {
        attributes,
        entityType: ConfluencePageEntityType,
        observedAt,
        pageId: page.id,
        revision,
        sourceUrl: normalizedSourceUrl,
        title: page.title
      })
      const events: Array<unknown> = [{
        _tag: "UpsertEntity",
        eventId: `confluence-page:${identityDigest}`,
        observedAt,
        revision,
        entityType: ConfluencePageEntityType,
        vendorImmutableId: page.id,
        sourceUrl: normalizedSourceUrl,
        title: page.title,
        attributes
      }]
      for (let index = 0; index < contributors.length; index++) {
        const contributor = contributors[index]
        if (contributor === undefined || !contributor.resolved) continue
        events.push({
          _tag: "UpsertPerson",
          eventId: `confluence-person:${identityDigest}:${index}`,
          observedAt,
          revision,
          vendorPersonId: contributor.accountId,
          displayName: contributor.displayName,
          avatarUrl: null,
          active: contributor.active
        })
      }
      if (isRunbookCandidate(page.title)) {
        const evidenceIdentityDigest = yield* digestSyncIdentity(input.cryptoService, {
          pageId: page.id,
          revision
        })
        const evidenceId = `confluence-runbook:${evidenceIdentityDigest}`
        events.push({
          _tag: "AppendEvidence",
          eventId: evidenceId,
          observedAt,
          revision,
          evidenceId,
          subject: { entityType: ConfluencePageEntityType, vendorImmutableId: page.id },
          evidenceType: "confluence.runbook-candidate",
          summary: `Runbook candidate: ${page.title}`.slice(0, 500).trim(),
          capturedAt: observedAt,
          data: {
            schemaVersion: 1,
            basis: "title-keyword",
            pageId: page.id,
            spaceId: page.spaceId
          }
        })
      }
      return events
    }),
    { concurrency: 4 }
  )
  return eventGroups.flat()
})

const splitSyncPage = Effect.fn("ConfluencePage.splitSyncPage")(function*(options: {
  readonly events: ReadonlyArray<unknown>
  readonly logicalCheckpoint: string
  readonly logicalHasMore: boolean
  readonly restartCheckpoint: string
}) {
  const capacityCheckpoint = options.logicalCheckpoint.length > options.restartCheckpoint.length
    ? options.logicalCheckpoint
    : options.restartCheckpoint
  const chunks: Array<Array<unknown>> = []
  let current: Array<unknown> = []
  for (const event of options.events) {
    const candidate = [...current, event]
    if (
      Option.isSome(
        Schema.decodeUnknownOption(PluginSyncPageV1)({
          events: candidate,
          checkpointAfterPage: capacityCheckpoint,
          hasMore: false
        })
      )
    ) {
      current = candidate
      continue
    }
    if (current.length === 0) return yield* malformed("confluence-sync", "confluence-sync-page-invalid")
    chunks.push(current)
    current = [event]
  }
  chunks.push(current)

  return yield* Effect.forEach(chunks, (events, index) => {
    const isLast = index === chunks.length - 1
    return decodeProvider(
      "confluence-sync",
      "confluence-sync-page-invalid",
      PluginSyncPageV1,
      {
        events,
        checkpointAfterPage: isLast ? options.logicalCheckpoint : options.restartCheckpoint,
        hasMore: isLast ? options.logicalHasMore : true
      }
    )
  })
})

const readSpaceSyncPage = Effect.fn("ConfluencePage.readSpaceSyncPage")(function*(
  input: MakeConfluencePageAdapterInput,
  cursor: string | null,
  pageNumber: number,
  previousInventoryDigest: string | null,
  previousBoundedPrefix: BoundedPrefixCheckpoint | null,
  seenCursors: Set<string>
) {
  const raw = yield* providerCall(input.client.getSpacePages(input.configuration.spaceId, cursor))
  const page: RawConfluenceSpacePageType = yield* decodeProvider(
    "confluence-space-pages",
    "confluence-space-page-invalid",
    RawConfluenceSpacePage,
    raw
  )
  const pages = page.results ?? []
  if (new Set(pages.map(({ id }) => id)).size !== pages.length) {
    return yield* malformed("confluence-space-pages", "confluence-page-identity-duplicate")
  }
  const following = yield* cursorFromNextLink(
    "confluence-space-pages",
    "confluence-space-page-cursor",
    page._links?.next,
    MAXIMUM_SYNC_CURSOR_LENGTH
  )
  if (following !== null && (following === cursor || seenCursors.has(following))) {
    return yield* malformed("confluence-space-pages", "confluence-space-page-cursor-loop")
  }
  if (following !== null) seenCursors.add(following)
  const events = yield* normalizeSyncEvents(input, pages)
  const inventoryDigest = yield* digestSyncIdentity(input.cryptoService, {
    events,
    previousInventoryDigest
  })
  const bounded = following !== null && pageNumber >= MAXIMUM_SPACE_PAGES_PER_SYNC
  const hasMore = following !== null && !bounded
  const normalized = yield* splitSyncPage({
    events,
    logicalCheckpoint: checkpointAfterPage(following, bounded, inventoryDigest, previousBoundedPrefix),
    logicalHasMore: hasMore,
    restartCheckpoint: checkpointBeforePage(cursor)
  })
  return {
    normalized,
    nextState: hasMore
      ? Option.some({ cursor: following, inventoryDigest, pageNumber: pageNumber + 1, previousBoundedPrefix })
      : Option.none()
  }
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
      const verifiedSite = input.configuration.oauthVerifiedSiteId === undefined
        ? yield* providerCall(input.client.getSystemInfo).pipe(
          Effect.flatMap((rawSystemInfo) =>
            decodeProvider(
              "confluence-system-info",
              "confluence-system-info-invalid",
              RawConfluenceSystemInfo,
              rawSystemInfo
            )
          )
        )
        : { cloudId: input.configuration.oauthVerifiedSiteId, siteTitle: undefined }
      if (verifiedSite.cloudId !== input.configuration.siteId) {
        return yield* malformed("confluence-system-info", "confluence-site-identity-mismatch")
      }
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
          providerImmutableId: verifiedSite.cloudId,
          displayName: verifiedSite.siteTitle ?? input.configuration.siteBaseUrl.hostname
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
    sync: (request) => {
      if (request.streamKey !== CONFLUENCE_PAGE_STREAM_KEY) {
        return Stream.fail(
          new PluginConfigurationFailure({ diagnosticCode: "confluence-sync-stream-unsupported" })
        )
      }
      return Stream.unwrap(
        Effect.suspend(() => {
          const seenCursors = new Set<string>()
          return syncCursorFromCheckpoint(request.checkpoint).pipe(
            Effect.map((checkpointState) => {
              if (checkpointState.cursor !== null) seenCursors.add(checkpointState.cursor)
              const initialState: {
                readonly previousBoundedPrefix: BoundedPrefixCheckpoint | null
                readonly cursor: string | null
                readonly inventoryDigest: string | null
                readonly pageNumber: number
              } = {
                previousBoundedPrefix: checkpointState.boundedPrefix,
                cursor: checkpointState.cursor,
                inventoryDigest: checkpointState.inventoryDigest,
                pageNumber: 1
              }
              return Stream.paginate(
                initialState,
                Effect.fn("ConfluencePage.streamSpacePages")(function*(state) {
                  const result = yield* readSpaceSyncPage(
                    input,
                    state.cursor,
                    state.pageNumber,
                    state.inventoryDigest,
                    state.previousBoundedPrefix,
                    seenCursors
                  )
                  return [result.normalized, result.nextState]
                })
              )
            })
          )
        })
      )
    },
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
  const cryptoService = yield* Crypto.Crypto
  return makeConfluencePageAdapter({ client, configuration, converter, cryptoService, descriptor })
})
