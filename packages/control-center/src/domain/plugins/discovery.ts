import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

import { SourceUrl } from "../sourceRevision.js"
import { UtcTimestamp } from "../utcTimestamp.js"

const SafeProviderIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
const SafeProviderLabel = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
)
const SafeDiscoveryEndpointUrl = SourceUrl.pipe(
  Schema.check(
    Schema.makeFilter(
      ({ hash, search }) => hash.length === 0 && search.length === 0,
      { expected: "a provider endpoint URL without query parameters or fragments" }
    )
  )
)

const ProviderContainer = Schema.Struct({
  providerImmutableId: SafeProviderIdentifier,
  displayName: SafeProviderLabel
})
const NullableProviderContainer = Schema.NullOr(ProviderContainer)

/** Secret-free provider endpoint advertised during connection discovery. */
export const PluginDiscoveryEndpointV1 = Schema.Struct({
  kind: Schema.Literals(["api", "web", "graphql", "webhook"]),
  url: SafeDiscoveryEndpointUrl,
  label: Schema.NullOr(SafeProviderLabel)
})

/** Decoded safe provider endpoint metadata. */
export type PluginDiscoveryEndpointV1 = typeof PluginDiscoveryEndpointV1.Type

/**
 * Safe connection metadata discovered from the provider.
 * Credentials, raw headers, and provider response bodies are deliberately absent.
 */
export const PluginDiscoveryV1 = Schema.Struct({
  account: NullableProviderContainer,
  workspace: NullableProviderContainer,
  resource: Schema.optional(NullableProviderContainer).pipe(
    Schema.decodeTo(Schema.toType(NullableProviderContainer), {
      decode: SchemaGetter.withDefault(Effect.succeed<typeof NullableProviderContainer.Type>(null)),
      encode: SchemaGetter.required()
    })
  ),
  endpoints: Schema.Array(PluginDiscoveryEndpointV1).check(
    Schema.makeFilter(
      (endpoints) => endpoints.length <= 20,
      { expected: "at most 20 safe provider endpoints" }
    )
  ),
  discoveredAt: UtcTimestamp
}).annotate({ identifier: "PluginDiscoveryV1" })

/** Decoded secret-free connection discovery metadata. */
export type PluginDiscoveryV1 = typeof PluginDiscoveryV1.Type
