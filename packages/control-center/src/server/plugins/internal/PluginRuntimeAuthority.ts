import * as Context from "effect/Context"
import * as Schema from "effect/Schema"

import { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../../domain/plugins/descriptor.js"
import { ProviderId } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"

/** Opaque digest of the exact configured runtime generation backing an executor lease. */
export const PluginRuntimeAuthorityToken = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("PluginRuntimeAuthorityToken"))

/** Decoded runtime-generation authority token. */
export type PluginRuntimeAuthorityToken = typeof PluginRuntimeAuthorityToken.Type

/** Secret-free digest of the credential/account generation used to construct a runtime. */
export const PluginRuntimeAccountDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("PluginRuntimeAccountDigest"))
export type PluginRuntimeAccountDigest = typeof PluginRuntimeAccountDigest.Type

/** Raw digest of one exact persisted configuration or negotiated descriptor. */
export const PluginRuntimeSourceDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("PluginRuntimeSourceDigest"))
export type PluginRuntimeSourceDigest = typeof PluginRuntimeSourceDigest.Type

/** Exact optional configuration revision bound into runtime authority. */
export const PluginRuntimeAuthorityConfiguration = Schema.Union([
  Schema.TaggedStruct("absent", {}),
  Schema.TaggedStruct("present", {
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    digest: PluginRuntimeSourceDigest
  })
]).pipe(Schema.toTaggedUnion("_tag"))
export type PluginRuntimeAuthorityConfiguration = typeof PluginRuntimeAuthorityConfiguration.Type

/** Persisted source snapshot expected by the runtime constructor. */
export const PluginRuntimeAuthorityExpectedSource = Schema.Struct({
  providerId: ProviderId,
  connectionRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  descriptorGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  configuration: PluginRuntimeAuthorityConfiguration,
  descriptorDigest: PluginRuntimeSourceDigest
})
export type PluginRuntimeAuthorityExpectedSource = typeof PluginRuntimeAuthorityExpectedSource.Type

/** Internal publication request; generation and authority digest are always server-derived. */
export const PublishPluginRuntimeAuthority = Schema.Struct({
  scope: Schema.Struct({
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId
  }),
  expected: PluginRuntimeAuthorityExpectedSource,
  accountDigest: PluginRuntimeAccountDigest,
  activatedAt: UtcTimestamp
})
export type PublishPluginRuntimeAuthority = typeof PublishPluginRuntimeAuthority.Type

/** Exact current runtime generation safe to bind to an executor lease. */
export const CurrentPluginRuntimeAuthority = Schema.Struct({
  ...PublishPluginRuntimeAuthority.fields,
  negotiated: NegotiatedPluginDescriptorV1,
  schemaVersion: Schema.Literal(1),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  runtimeAuthorityToken: PluginRuntimeAuthorityToken
})
export type CurrentPluginRuntimeAuthority = typeof CurrentPluginRuntimeAuthority.Type

/** The requested runtime generation is absent or no longer matches its persisted sources. */
export class PluginRuntimeAuthorityUnavailable extends Schema.TaggedErrorClass<PluginRuntimeAuthorityUnavailable>()(
  "PluginRuntimeAuthorityUnavailable",
  {}
) {}

/** A publication lost a source or generation compare-and-swap race. */
export class PluginRuntimeAuthorityPublicationConflict
  extends Schema.TaggedErrorClass<PluginRuntimeAuthorityPublicationConflict>()(
    "PluginRuntimeAuthorityPublicationConflict",
    {
      reason: Schema.Literals([
        "source-missing",
        "source-disabled",
        "source-changed",
        "concurrent-publication"
      ])
    }
  )
{}

/** Internal runtime metadata acquired in the same scope as its executor. */
export class PluginRuntimeAuthority extends Context.Service<
  PluginRuntimeAuthority,
  PluginRuntimeAuthorityToken
>()("@knpkv/control-center/internal/PluginRuntimeAuthority") {}
