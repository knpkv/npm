import * as Schema from "effect/Schema"

import { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { hasMaximumPluginJsonBytes } from "../../../domain/plugins/bounds.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { SecretRef } from "../../secrets/SecretRef.js"
import { ContentBlobDigest } from "./models.js"

/** Stable field key from a negotiated plugin descriptor. */
export const StoredPluginConfigurationKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
).pipe(Schema.brand("StoredPluginConfigurationKey"))

export type StoredPluginConfigurationKey = typeof StoredPluginConfigurationKey.Type

const common = { key: StoredPluginConfigurationKey }
const boundedValue = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(4_096))

/** Durable non-secret value or opaque secret reference for one plugin field. */
export const StoredPluginConfigurationValue = Schema.Union([
  Schema.TaggedStruct("text", { ...common, value: boundedValue }),
  Schema.TaggedStruct("url", { ...common, value: boundedValue }),
  Schema.TaggedStruct("boolean", { ...common, value: Schema.Boolean }),
  Schema.TaggedStruct("integer", { ...common, value: Schema.Int }),
  Schema.TaggedStruct("select", { ...common, value: boundedValue }),
  Schema.TaggedStruct("secret-reference", { ...common, ref: SecretRef })
]).pipe(Schema.toTaggedUnion("_tag"))

export type StoredPluginConfigurationValue = typeof StoredPluginConfigurationValue.Type

/** Canonical ordered plugin configuration persisted as bounded JSON. */
export const StoredPluginConfiguration = Schema.Array(StoredPluginConfigurationValue).check(
  Schema.makeFilter((values) => values.length <= 100, {
    expected: "at most 100 plugin configuration values"
  }),
  Schema.makeFilter(
    (values) => new Set(values.map(({ key }) => key)).size === values.length,
    { expected: "unique plugin configuration keys" }
  ),
  Schema.makeFilter(
    (values) =>
      values.slice(1).every((value, index) => {
        const previous = values[index]
        return previous !== undefined && previous.key < value.key
      }),
    { expected: "plugin configuration values ordered by key" }
  ),
  hasMaximumPluginJsonBytes(64 * 1024)
)

export type StoredPluginConfiguration = typeof StoredPluginConfiguration.Type

/** Revisioned secret-safe configuration record. */
export const PluginConfigurationRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  values: StoredPluginConfiguration,
  configurationDigest: ContentBlobDigest,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

export type PluginConfigurationRecord = typeof PluginConfigurationRecord.Type
