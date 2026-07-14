import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"

import type { ControlCenterLiveEvent } from "../../api/liveEvents.js"
import type { OpaqueMediaId, SafeMediaContentType } from "../../api/media.js"
import type {
  PatchPluginConfigurationRequest,
  PluginConfiguration,
  PluginConfigurationMetadata,
  PluginConnectionSummary,
  PluginHealthResponse
} from "../../api/plugins.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type { EventCursor, PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

/** An authenticated resource does not exist within the caller's workspace. */
export class ApplicationResourceNotFound extends Schema.TaggedErrorClass<ApplicationResourceNotFound>()(
  "ApplicationResourceNotFound",
  {}
) {}

/** A bounded application operation cannot currently be served. */
export class ApplicationServiceUnavailable extends Schema.TaggedErrorClass<ApplicationServiceUnavailable>()(
  "ApplicationServiceUnavailable",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** A provider-specific read budget was exhausted. */
export class ApplicationRateLimited extends Schema.TaggedErrorClass<ApplicationRateLimited>()(
  "ApplicationRateLimited",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** Durable state changed since the caller read its compare-and-swap revision. */
export class ApplicationConflict extends Schema.TaggedErrorClass<ApplicationConflict>()(
  "ApplicationConflict",
  {}
) {}

/** An application-level mutation failed validation after transport decoding. */
export class ApplicationInvalidRequest extends Schema.TaggedErrorClass<ApplicationInvalidRequest>()(
  "ApplicationInvalidRequest",
  {}
) {}

export type PluginAdministrationError =
  | ApplicationRateLimited
  | ApplicationResourceNotFound
  | ApplicationServiceUnavailable

/** Secret-free plugin administration seam. Executor processes are deliberately absent. */
export interface PluginAdministrationService {
  readonly list: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<PluginConnectionSummary>, ApplicationServiceUnavailable>
  readonly health: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<typeof PluginHealthResponse.Type, PluginAdministrationError>
  readonly configurationMetadata: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<PluginConfigurationMetadata, PluginAdministrationError>
  readonly configuration: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<typeof PluginConfiguration.Type, PluginAdministrationError>
  readonly patchConfiguration: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly patch: typeof PatchPluginConfigurationRequest.Type
  }) => Effect.Effect<
    typeof PluginConfiguration.Type,
    | ApplicationConflict
    | ApplicationInvalidRequest
    | PluginAdministrationError
  >
}

/** Injectable plugin query boundary used by the HTTP handlers. */
export class PluginAdministration extends Context.Service<
  PluginAdministration,
  PluginAdministrationService
>()("@knpkv/control-center/server/api/PluginAdministration") {}

/** Injectable bird's-eye portfolio projection boundary. */
export class PortfolioSnapshots extends Context.Service<PortfolioSnapshots, {
  readonly snapshot: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<PortfolioSnapshot, ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/PortfolioSnapshots") {}

/** Injectable durable replay boundary used by the authenticated SSE handler. */
export class LiveEvents extends Context.Service<LiveEvents, {
  readonly open: (input: {
    readonly workspaceId: WorkspaceId
    readonly after: EventCursor | undefined
  }) => Effect.Effect<Stream.Stream<ControlCenterLiveEvent>, ApplicationServiceUnavailable, Scope.Scope>
}>()("@knpkv/control-center/server/api/LiveEvents") {}

/** Fully authorized media stream whose provider address and storage key remain private. */
export interface MediaRead {
  readonly body: Stream.Stream<Uint8Array>
  readonly contentLength: number
  readonly contentType: SafeMediaContentType
}

/** Injectable opaque media boundary; implementations must authorize before returning a stream. */
export class MediaReads extends Context.Service<MediaReads, {
  readonly read: (input: {
    readonly workspaceId: WorkspaceId
    readonly mediaId: OpaqueMediaId
  }) => Effect.Effect<MediaRead, ApplicationResourceNotFound | ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/MediaReads") {}
