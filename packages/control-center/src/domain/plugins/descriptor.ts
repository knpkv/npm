import * as Schema from "effect/Schema"

import { hasMaximumPluginJsonBytes, MaximumPluginDescriptorBytes } from "./bounds.js"

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

const boundedIdentifier = (name: string, maximum: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximum)
  ).pipe(Schema.brand(name))

/** Stable reverse-DNS identity of a plugin, independent of package abbreviations. */
export const PluginId = boundedIdentifier("PluginId", 200)

/** Decoded stable plugin identity. */
export type PluginId = typeof PluginId.Type

/** Strict structured semantic version used by plugin and adapter contracts. */
export const SemanticVersion = Schema.Struct({
  major: NonNegativeInteger,
  minor: NonNegativeInteger,
  patch: NonNegativeInteger
}).annotate({ identifier: "SemanticVersion" })

/** Decoded semantic version. */
export type SemanticVersion = typeof SemanticVersion.Type

/** Independently versioned operations understood by the Control Center host. */
export const PluginCapabilityId = Schema.Literals([
  "entity.read",
  "sync.incremental",
  "action.propose",
  "action.execute",
  "action.cancel",
  "action.reconcile",
  "diff.inventory",
  "diff.content"
]).annotate({ identifier: "PluginCapabilityId" })

/** Decoded plugin capability identity. */
export type PluginCapabilityId = typeof PluginCapabilityId.Type

/** A capability and the contract versions an adapter can implement. */
export const PluginCapabilityOfferV1 = Schema.Struct({
  capabilityId: PluginCapabilityId,
  supportedVersions: Schema.Array(PositiveInteger).check(
    Schema.isNonEmpty(),
    Schema.isUnique(),
    Schema.makeFilter((versions) => versions.length <= 16, {
      expected: "at most 16 supported capability versions"
    })
  ),
  requirement: Schema.Literals(["required", "optional"])
}).annotate({ identifier: "PluginCapabilityOfferV1" })

/** Decoded capability offer. */
export type PluginCapabilityOfferV1 = typeof PluginCapabilityOfferV1.Type

const ConfigurationKey = boundedIdentifier("PluginConfigurationKey", 100)
const ConfigurationLabel = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
)
const ConfigurationDescription = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

const commonConfigurationFields = {
  key: ConfigurationKey,
  label: ConfigurationLabel,
  description: ConfigurationDescription,
  required: Schema.Boolean
}

const TextConfigurationField = Schema.TaggedStruct("text", commonConfigurationFields)
const UrlConfigurationField = Schema.TaggedStruct("url", commonConfigurationFields)
const BooleanConfigurationField = Schema.TaggedStruct("boolean", commonConfigurationFields)
const IntegerConfigurationField = Schema.TaggedStruct("integer", {
  ...commonConfigurationFields,
  minimum: Schema.NullOr(Schema.Int),
  maximum: Schema.NullOr(Schema.Int)
}).check(
  Schema.makeFilter(
    ({ maximum, minimum }) => maximum === null || minimum === null || minimum <= maximum,
    { expected: "plugin integer configuration minimum not to exceed maximum" }
  )
)
const SelectConfigurationField = Schema.TaggedStruct("select", {
  ...commonConfigurationFields,
  options: Schema.Array(Schema.Struct({
    label: ConfigurationLabel,
    value: boundedIdentifier("PluginConfigurationOption", 200)
  })).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((options) => options.length <= 100, {
      expected: "at most 100 plugin configuration options"
    }),
    Schema.makeFilter(
      (options) => new Set(options.map(({ value }) => value)).size === options.length,
      { expected: "unique plugin configuration option values" }
    )
  )
})
const SecretReferenceConfigurationField = Schema.TaggedStruct("secret-reference", {
  ...commonConfigurationFields,
  secretKind: Schema.Literals(["token", "password", "private-key", "certificate", "opaque"])
})

/** Secret-free metadata describing a plugin configuration field. */
export const PluginConfigurationFieldV1 = Schema.Union([
  TextConfigurationField,
  UrlConfigurationField,
  BooleanConfigurationField,
  IntegerConfigurationField,
  SelectConfigurationField,
  SecretReferenceConfigurationField
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded plugin configuration metadata. */
export type PluginConfigurationFieldV1 = typeof PluginConfigurationFieldV1.Type

/** Raw version-one descriptor decoded before an adapter factory may run. */
export const PluginDescriptorV1 = Schema.Struct({
  contractId: Schema.Literal("dev.knpkv.control-center.plugin"),
  contractVersion: SemanticVersion,
  pluginId: PluginId,
  adapterVersion: SemanticVersion,
  displayName: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(200)
  ),
  configurationFields: Schema.Array(PluginConfigurationFieldV1).check(
    Schema.makeFilter((fields) => fields.length <= 100, {
      expected: "at most 100 plugin configuration fields"
    }),
    Schema.makeFilter(
      (fields) => new Set(fields.map(({ key }) => key)).size === fields.length,
      { expected: "unique plugin configuration field keys" }
    )
  ),
  capabilities: Schema.Array(PluginCapabilityOfferV1).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((capabilities) => capabilities.length <= 32, {
      expected: "at most 32 plugin capability offers"
    })
  )
}).check(
  hasMaximumPluginJsonBytes(MaximumPluginDescriptorBytes)
).annotate({ identifier: "PluginDescriptorV1" })

/** Decoded version-one plugin descriptor. */
export type PluginDescriptorV1 = typeof PluginDescriptorV1.Type

/** One capability version selected by the host during negotiation. */
export const NegotiatedPluginCapabilityV1 = Schema.Struct({
  capabilityId: PluginCapabilityId,
  version: PositiveInteger
}).annotate({ identifier: "NegotiatedPluginCapabilityV1" })

/** Decoded negotiated capability. */
export type NegotiatedPluginCapabilityV1 = typeof NegotiatedPluginCapabilityV1.Type

/** Descriptor accepted by the host after contract and capability negotiation. */
export const NegotiatedPluginDescriptorV1 = Schema.Struct({
  descriptor: PluginDescriptorV1,
  capabilities: Schema.Array(NegotiatedPluginCapabilityV1).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((capabilities) => capabilities.length <= 32, {
      expected: "at most 32 negotiated plugin capabilities"
    }),
    Schema.makeFilter(
      (capabilities) => new Set(capabilities.map(({ capabilityId }) => capabilityId)).size === capabilities.length,
      { expected: "unique negotiated plugin capabilities" }
    )
  )
}).annotate({ identifier: "NegotiatedPluginDescriptorV1" })

/** Decoded negotiated plugin descriptor. */
export type NegotiatedPluginDescriptorV1 = typeof NegotiatedPluginDescriptorV1.Type
