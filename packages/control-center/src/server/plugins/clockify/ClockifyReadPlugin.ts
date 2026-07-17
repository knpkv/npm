/** Production Clockify time-entry read plugin runtime. */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  PluginDiscoveryV1,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ReadPluginEntityRequestV1,
  type ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import {
  PluginConfigurationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginTimeoutFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnection, PluginConnectionV1 } from "../PluginConnection.js"
import { buildPluginDefinitionLayer, definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import { type ClockifyReadProvider, makeClockifyReadProvider } from "./ClockifyReadProvider.js"
import { digestClockifySyncScope, normalizeClockifyTimeEntry } from "./ClockifyTimeEntryNormalization.js"

const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
const MaximumPages = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
const MaximumConcurrency = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
const OperationTimeoutMillis = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }))
const ClockifyIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const ClockifyUserIdsText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096))
const ClockifyWebBaseUrl = SourceUrl.pipe(
  Schema.check(
    Schema.makeFilter(({ hash, pathname, search }) => hash.length === 0 && search.length === 0 && pathname === "/", {
      expected: "a root Clockify web URL without query parameters or fragments"
    })
  )
)

/** Secret-free runtime settings for the Clockify read adapter. */
export const ClockifyReadPluginConfiguration = Schema.Struct({
  webBaseUrl: ClockifyWebBaseUrl,
  workspaceId: ClockifyIdentifier,
  userIds: ClockifyUserIdsText,
  pageSize: PageSize,
  maximumPages: MaximumPages,
  maximumConcurrency: MaximumConcurrency,
  operationTimeoutMillis: OperationTimeoutMillis
})

/** Decoded Clockify read adapter settings. */
export type ClockifyReadPluginConfiguration = typeof ClockifyReadPluginConfiguration.Type

/** Negotiated production runtime and its scoped plugin layer. */
export interface ClockifyReadPluginRuntime {
  readonly definition: PluginDefinitionV1
  readonly layer: Layer.Layer<PluginConnection, PluginFailure, Crypto.Crypto>
}

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.clockify.read",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Clockify time-entry reader",
  configurationFields: [
    {
      _tag: "url",
      key: "webBaseUrl",
      label: "Clockify site URL",
      description: "Browser-facing Clockify root URL without credentials, query, or fragment.",
      required: true
    },
    {
      _tag: "text",
      key: "workspaceId",
      label: "Clockify workspace ID",
      description: "Immutable Clockify workspace identifier read by this connection.",
      required: true
    },
    {
      _tag: "text",
      key: "userIds",
      label: "Clockify user IDs",
      description: "Comma-separated immutable user IDs included in the bounded time-entry sync.",
      required: true
    },
    {
      _tag: "integer",
      key: "pageSize",
      label: "Time-entry page size",
      description: "Maximum entries requested for each configured user in one provider page.",
      required: true,
      minimum: 1,
      maximum: 50
    },
    {
      _tag: "integer",
      key: "maximumPages",
      label: "Maximum time-entry pages",
      description: "Hard provider-page limit for one snapshot sync.",
      required: true,
      minimum: 1,
      maximum: 10
    },
    {
      _tag: "integer",
      key: "maximumConcurrency",
      label: "Maximum concurrency",
      description: "Maximum simultaneous user page reads and entry normalization operations.",
      required: true,
      minimum: 1,
      maximum: 5
    },
    {
      _tag: "integer",
      key: "operationTimeoutMillis",
      label: "Request timeout",
      description: "Maximum milliseconds for each Clockify provider request.",
      required: true,
      minimum: 1_000,
      maximum: 120_000
    }
  ],
  capabilities: ["entity.read", "sync.incremental"].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
} satisfies unknown

const ClockifyUserIds = Schema.Array(ClockifyIdentifier).check(
  Schema.isNonEmpty(),
  Schema.makeFilter((values) => values.length <= 10, { expected: "at most 10 Clockify user IDs" }),
  Schema.isUnique()
)
const ClockifyUser = Schema.Struct({
  id: ClockifyIdentifier,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
})
const ClockifyWorkspaces = Schema.Array(
  Schema.Struct({
    id: ClockifyIdentifier,
    name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
  })
)
const ClockifyTimeEntryPage = Schema.Array(Schema.Unknown).check(
  Schema.makeFilter((values) => values.length <= 50, { expected: "at most 50 Clockify time entries" })
)
const ClockifyCheckpointPage = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 }))
)
const ClockifyCheckpointScopeDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 sync-scope digest" })
)
const ClockifyCheckpoint = Schema.Union([
  Schema.TemplateLiteralParser(["next:", ClockifyCheckpointPage, ":", ClockifyCheckpointScopeDigest]),
  Schema.TemplateLiteralParser(["bounded:", ClockifyCheckpointPage, ":", ClockifyCheckpointScopeDigest]),
  Schema.TemplateLiteralParser(["complete:", ClockifyCheckpointScopeDigest])
])

const malformed = (operation: string, diagnosticCode: string) =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const decodeProvider = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  diagnosticCode: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => malformed(operation, diagnosticCode)))

const unsupported = (
  capabilityId: "entity.read" | "action.propose" | "action.execute" | "action.cancel" | "action.reconcile"
) =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "clockify-read-adapter-read-only"
  })

const withTimeout = <Value>(
  operation: string,
  duration: number,
  effect: Effect.Effect<Value, PluginFailure>
): Effect.Effect<Value, PluginFailure> =>
  Effect.timeoutOrElse(effect, {
    duration,
    orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
  })

const decodeUserIds = (text: string): Effect.Effect<ReadonlyArray<string>, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(ClockifyUserIds)(text.split(",").map((value) => value.trim())).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "clockify-user-ids-invalid" }))
  )

const startPageFromCheckpoint = (
  checkpoint: PluginSyncRequestV1["checkpoint"],
  maximumPages: number,
  syncScopeDigest: string
): Effect.Effect<number, PluginConfigurationFailure> =>
  checkpoint === null
    ? Effect.succeed(1)
    : Schema.decodeUnknownEffect(ClockifyCheckpoint)(checkpoint).pipe(
      Effect.mapError(
        () =>
          new PluginConfigurationFailure({
            diagnosticCode: "clockify-sync-checkpoint-invalid"
          })
      ),
      Effect.flatMap((decoded) => {
        const checkpointScopeDigest = decoded[0] === "complete:" ? decoded[1] : decoded[3]
        if (checkpointScopeDigest !== syncScopeDigest) return Effect.succeed(1)
        if (decoded[0] !== "next:") return Effect.succeed(1)
        return decoded[1] <= maximumPages
          ? Effect.succeed(decoded[1])
          : Effect.fail(
            new PluginConfigurationFailure({
              diagnosticCode: "clockify-sync-checkpoint-invalid"
            })
          )
      })
    )

interface DecodedWorkspaceContext {
  readonly user: typeof ClockifyUser.Type
  readonly workspace: (typeof ClockifyWorkspaces.Type)[number]
}

const readWorkspaceContext = Effect.fn("ClockifyReadPlugin.readWorkspaceContext")(function*(
  provider: ClockifyReadProvider,
  configuration: ClockifyReadPluginConfiguration,
  operation: string
): Effect.fn.Return<DecodedWorkspaceContext, PluginFailure> {
  const [rawUser, rawWorkspaces] = yield* Effect.all(
    [
      withTimeout("clockify-current-user", configuration.operationTimeoutMillis, provider.getCurrentUser),
      withTimeout("clockify-workspaces", configuration.operationTimeoutMillis, provider.getWorkspaces)
    ],
    { concurrency: 2 }
  )
  const user = yield* decodeProvider(operation, "clockify-current-user-shape-invalid", ClockifyUser, rawUser)
  const workspaces = yield* decodeProvider(
    operation,
    "clockify-workspaces-shape-invalid",
    ClockifyWorkspaces,
    rawWorkspaces
  )
  const workspace = workspaces.find(({ id }) => id === configuration.workspaceId)
  if (workspace === undefined) {
    return yield* new PluginConfigurationFailure({ diagnosticCode: "clockify-workspace-not-accessible" })
  }
  return { user, workspace }
})

const streamSyncPages = (options: {
  readonly provider: ClockifyReadProvider
  readonly configuration: ClockifyReadPluginConfiguration
  readonly userIds: ReadonlyArray<string>
  readonly syncScopeDigest: string
  readonly startPage: number
}): Stream.Stream<typeof PluginSyncPageV1.Type, PluginFailure, Crypto.Crypto> =>
  Stream.paginate(
    options.startPage,
    Effect.fn("ClockifyReadPlugin.streamSyncPages")(function*(page) {
      const userPages = yield* Effect.forEach(
        options.userIds,
        (userId) =>
          withTimeout(
            "clockify-get-time-entries",
            options.configuration.operationTimeoutMillis,
            options.provider.getTimeEntries(options.configuration.workspaceId, userId, {
              page,
              pageSize: options.configuration.pageSize
            })
          ).pipe(
            Effect.flatMap((raw) =>
              decodeProvider("clockify-sync", "clockify-time-entry-page-shape-invalid", ClockifyTimeEntryPage, raw)
            ),
            Effect.flatMap((entries) =>
              entries.length > options.configuration.pageSize
                ? Effect.fail(malformed("clockify-sync", "clockify-time-entry-page-limit-exceeded"))
                : Effect.succeed({ entries, userId })
            )
          ),
        { concurrency: options.configuration.maximumConcurrency }
      )
      const providerHasMore = userPages.some(({ entries }) => entries.length === options.configuration.pageSize)
      const reachedBound = page === options.configuration.maximumPages && providerHasMore
      const entries = userPages.flatMap(({ entries, userId }) => entries.map((entry) => ({ entry, userId })))
      const events = yield* Effect.forEach(
        entries,
        ({ entry, userId }) =>
          normalizeClockifyTimeEntry({
            entry,
            expectedWorkspaceId: options.configuration.workspaceId,
            expectedUserId: userId
          }),
        { concurrency: options.configuration.maximumConcurrency }
      )
      if (new Set(events.map(({ vendorImmutableId }) => vendorImmutableId)).size !== events.length) {
        return yield* malformed("clockify-sync", "clockify-time-entry-identity-duplicate")
      }
      const hasMore = providerHasMore && !reachedBound
      const checkpointAfterPage = hasMore
        ? `next:${page + 1}:${options.syncScopeDigest}`
        : reachedBound
        ? `bounded:${page}:${options.syncScopeDigest}`
        : `complete:${options.syncScopeDigest}`
      const normalized = yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncPageV1))({
        events,
        checkpointAfterPage,
        hasMore
      }).pipe(Effect.mapError(() => malformed("clockify-sync", "clockify-sync-page-invalid")))
      const result: readonly [
        ReadonlyArray<typeof PluginSyncPageV1.Type>,
        Option.Option<number>
      ] = [[normalized], hasMore ? Option.some(page + 1) : Option.none<number>()]
      return result
    })
  )

const readTimeEntry = Effect.fn("ClockifyReadPlugin.readTimeEntry")(function*(
  provider: ClockifyReadProvider,
  configuration: ClockifyReadPluginConfiguration,
  request: ReadPluginEntityRequestV1
): Effect.fn.Return<ReadPluginEntityResultV1, PluginFailure, Crypto.Crypto> {
  if (request.entityType !== "clockify.time-entry") {
    return yield* unsupported("entity.read")
  }
  const entry = yield* withTimeout(
    "clockify-get-time-entry",
    configuration.operationTimeoutMillis,
    provider.getTimeEntry(configuration.workspaceId, request.vendorImmutableId)
  )
  if (Option.isNone(entry)) {
    return { _tag: "missing", reference: request, observedAt: yield* DateTime.now }
  }
  const event = yield* normalizeClockifyTimeEntry({
    entry: entry.value,
    expectedWorkspaceId: configuration.workspaceId
  })
  if (event.vendorImmutableId !== request.vendorImmutableId) {
    return yield* malformed("clockify-read-entity", "clockify-time-entry-identity-mismatch")
  }
  return { _tag: "found", event }
})

const makeRuntime = (provider: ClockifyReadProvider, configuration: unknown): ClockifyReadPluginRuntime => {
  const definition = definePluginV1({
    rawDescriptor: descriptor,
    configurationSchema: ClockifyReadPluginConfiguration,
    capabilityCodecs: {
      entityRead: pluginCapabilityCodecsV1.entityRead,
      syncIncremental: pluginCapabilityCodecsV1.syncIncremental
    },
    make: ({ configuration: decoded, descriptor: negotiated }) =>
      Effect.gen(function*() {
        const userIds = yield* decodeUserIds(decoded.userIds)
        if (userIds.length * decoded.pageSize > 100) {
          return yield* new PluginConfigurationFailure({
            diagnosticCode: "clockify-sync-page-capacity-exceeded"
          })
        }
        const cryptoService = yield* Crypto.Crypto
        const syncScopeDigest = yield* digestClockifySyncScope({
          maximumPages: decoded.maximumPages,
          pageSize: decoded.pageSize,
          userIds,
          workspaceId: decoded.workspaceId
        })
        const connection: PluginConnectionV1 = {
          descriptor: negotiated,
          discover: Effect.gen(function*() {
            const context = yield* readWorkspaceContext(provider, decoded, "clockify-discover")
            const discoveredAt = yield* DateTime.now
            return yield* Schema.decodeUnknownEffect(Schema.toType(PluginDiscoveryV1))({
              account: {
                providerImmutableId: context.user.id,
                displayName: context.user.name
              },
              workspace: {
                providerImmutableId: context.workspace.id,
                displayName: context.workspace.name
              },
              endpoints: [{ kind: "web", url: decoded.webBaseUrl, label: "Clockify" }],
              discoveredAt
            }).pipe(Effect.mapError(() => malformed("clockify-discover", "clockify-discovery-shape-invalid")))
          }),
          health: Effect.gen(function*() {
            yield* readWorkspaceContext(provider, decoded, "clockify-health")
            const checkedAt = yield* DateTime.now
            return yield* Schema.decodeUnknownEffect(Schema.toType(PluginHealth))({
              _tag: "healthy",
              checkedAt
            }).pipe(Effect.mapError(() => malformed("clockify-health", "clockify-health-shape-invalid")))
          }),
          sync: (request) => {
            if (request.streamKey !== "time-entries") {
              return Stream.fail(new PluginConfigurationFailure({ diagnosticCode: "clockify-sync-stream-unsupported" }))
            }
            return Stream.unwrap(
              startPageFromCheckpoint(request.checkpoint, decoded.maximumPages, syncScopeDigest).pipe(
                Effect.map((startPage) =>
                  streamSyncPages({
                    provider,
                    configuration: decoded,
                    userIds,
                    syncScopeDigest,
                    startPage
                  }).pipe(Stream.provideService(Crypto.Crypto, cryptoService))
                )
              )
            )
          },
          readEntity: (request) =>
            readTimeEntry(provider, decoded, request).pipe(Effect.provideService(Crypto.Crypto, cryptoService)),
          diff: Option.none(),
          proposeAction: () => Effect.fail(unsupported("action.propose"))
        }
        const executor: AuthorizedPluginExecutorV1 = {
          preflight: () => Effect.fail(unsupported("action.execute")),
          executeAuthorizedAction: () => Effect.fail(unsupported("action.execute")),
          requestCancellation: () => Effect.fail(unsupported("action.cancel")),
          reconcile: () => Effect.fail(unsupported("action.reconcile"))
        }
        return { connection, executor }
      })
  })
  return {
    definition,
    layer: buildPluginDefinitionLayer(definition, configuration)
  }
}

/** Build a production Clockify runtime from the configured shared API client. */
export const makeClockifyReadPluginRuntime = (
  configuration: unknown
): Effect.Effect<ClockifyReadPluginRuntime, never, ClockifyApiClient> =>
  Effect.map(ClockifyApiClient, (client) => makeRuntime(makeClockifyReadProvider(client), configuration))

/** Build the runtime around a deterministic provider double. @internal */
export const makeClockifyReadPluginRuntimeFromProvider = makeRuntime
