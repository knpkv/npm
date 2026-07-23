import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  type NegotiatedPluginCapabilityV1,
  NegotiatedPluginDescriptorV1,
  type PluginCapabilityId as PluginCapabilityIdType,
  PluginDescriptorV1,
  type PluginDescriptorV1 as PluginDescriptorV1Type,
  SemanticVersion
} from "../../domain/plugins/descriptor.js"
import { PluginMalformedResponseFailure, PluginUnsupportedCapabilityFailure } from "./failures.js"

const DescriptorEnvelope = Schema.Struct({
  contractId: Schema.Literal("dev.knpkv.control-center.plugin"),
  contractVersion: SemanticVersion
})

/** Capability versions implemented by this host contract major. */
export const HOST_PLUGIN_CAPABILITY_VERSIONS: Readonly<
  Record<PluginCapabilityIdType, ReadonlyArray<number>>
> = {
  "entity.read": [1],
  "sync.incremental": [1],
  "action.propose": [1],
  "action.execute": [1],
  "action.cancel": [1],
  "action.reconcile": [1],
  "diff.inventory": [1, 2],
  "diff.content": [1, 2]
}

const selectHighestCommonVersion = (
  capabilityId: PluginCapabilityIdType,
  offered: ReadonlyArray<number>
): number | null => {
  const supported = new Set(HOST_PLUGIN_CAPABILITY_VERSIONS[capabilityId])
  const common = offered.filter((version) => supported.has(version)).sort((left, right) => right - left)
  return common[0] ?? null
}

const decodeDescriptor = (raw: unknown) => {
  const envelope = Schema.decodeUnknownResult(DescriptorEnvelope)(raw)
  if (Result.isFailure(envelope)) {
    return Effect.fail(
      new PluginMalformedResponseFailure({
        operation: "plugin-descriptor",
        diagnosticCode: "plugin-descriptor-envelope-invalid"
      })
    )
  }
  if (envelope.success.contractVersion.major !== 1) {
    return Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: null,
        requestedVersion: envelope.success.contractVersion.major,
        diagnosticCode: "plugin-contract-major-unsupported"
      })
    )
  }
  return Schema.decodeUnknownEffect(PluginDescriptorV1)(raw).pipe(
    Effect.mapError(
      () =>
        new PluginMalformedResponseFailure({
          operation: "plugin-descriptor",
          diagnosticCode: "plugin-descriptor-schema-invalid"
        })
    )
  )
}

const negotiateCapabilities = Effect.fn("PluginContract.negotiateCapabilities")(function*(
  descriptor: PluginDescriptorV1Type
) {
  const seen = new Set<PluginCapabilityIdType>()
  const capabilities: Array<NegotiatedPluginCapabilityV1> = []

  for (const offer of descriptor.capabilities) {
    if (seen.has(offer.capabilityId)) {
      return yield* new PluginMalformedResponseFailure({
        operation: "plugin-descriptor",
        diagnosticCode: "plugin-capability-duplicate"
      })
    }
    seen.add(offer.capabilityId)
    const version = selectHighestCommonVersion(offer.capabilityId, offer.supportedVersions)
    if (version === null) {
      if (offer.requirement === "required") {
        return yield* new PluginUnsupportedCapabilityFailure({
          capabilityId: offer.capabilityId,
          requestedVersion: Math.max(...offer.supportedVersions),
          diagnosticCode: "plugin-required-capability-unsupported"
        })
      }
      continue
    }
    capabilities.push({ capabilityId: offer.capabilityId, version })
  }

  const decoded = yield* Schema.decodeUnknownEffect(NegotiatedPluginDescriptorV1)({
    descriptor,
    capabilities
  }).pipe(
    Effect.mapError(
      () =>
        new PluginMalformedResponseFailure({
          operation: "plugin-descriptor",
          diagnosticCode: "plugin-negotiated-descriptor-invalid"
        })
    )
  )
  return decoded
})

/** Decode and negotiate a descriptor before any plugin factory can be invoked. */
export const negotiatePluginDescriptorV1 = Effect.fn("PluginContract.negotiateDescriptor")(function*(
  raw: unknown
) {
  const descriptor = yield* decodeDescriptor(raw)
  return yield* negotiateCapabilities(descriptor)
})

/** Whether a negotiated descriptor exposes one exact capability version. */
export const hasPluginCapability = (
  descriptor: typeof NegotiatedPluginDescriptorV1.Type,
  capabilityId: PluginCapabilityIdType,
  version: number
): boolean =>
  descriptor.capabilities.some(
    (capability) => capability.capabilityId === capabilityId && capability.version === version
  )
