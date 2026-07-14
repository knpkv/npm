import * as Schema from "effect/Schema"

const jsonEncoder = new TextEncoder()

const hasMaximumJsonBytes = (maximumBytes: number) =>
  Schema.makeFilter(
    (value: unknown) => {
      const serialized = JSON.stringify(value)
      return serialized !== undefined && jsonEncoder.encode(serialized).byteLength <= maximumBytes
    },
    { expected: `JSON encoded as at most ${maximumBytes} UTF-8 bytes` }
  )

/** Maximum persisted or dispatched JSON payload accepted from a plugin boundary. */
export const MaximumPluginPayloadBytes = 262_144

/** Maximum encoded size of one atomic normalized sync page. */
export const MaximumPluginSyncPageBytes = 1_048_576

/** Maximum canonical descriptor JSON accepted before adapter construction. */
export const MaximumPluginDescriptorBytes = 61_440

/** Bounded JSON for normalized evidence and governed-action payloads. */
export const PluginPayloadJson = Schema.Json.check(hasMaximumJsonBytes(MaximumPluginPayloadBytes)).annotate({
  identifier: "PluginPayloadJson"
})

/** Applies a deterministic upper bound to an already-decoded JSON-shaped value. */
export const hasMaximumPluginJsonBytes = hasMaximumJsonBytes
