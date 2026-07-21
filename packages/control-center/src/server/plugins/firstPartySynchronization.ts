import type { NegotiatedPluginDescriptorV1 } from "../../domain/plugins/descriptor.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { jiraReadPluginDescriptor } from "./jira/JiraReadPlugin.js"
import { hasPluginCapability } from "./negotiation.js"

const compatibleHistoricalJiraAdapterVersion = { major: 0, minor: 1, patch: 0 }
const FIRST_PARTY_SYNC_STREAMS: Readonly<Record<ProviderId, string>> = {
  codecommit: "pull-requests",
  codepipeline: "executions",
  jira: "project-issues",
  clockify: "time-entries",
  confluence: "pages"
}

/** Resolve the production synchronization stream owned by a first-party provider. */
export const firstPartySyncStreamKey = (providerId: ProviderId): string => FIRST_PARTY_SYNC_STREAMS[providerId]

const sameVersion = (
  left: { readonly major: number; readonly minor: number; readonly patch: number },
  right: { readonly major: number; readonly minor: number; readonly patch: number }
): boolean => left.major === right.major && left.minor === right.minor && left.patch === right.patch

const isCompatibleHistoricalJiraDescriptor = (
  negotiated: typeof NegotiatedPluginDescriptorV1.Type
): boolean => {
  const { descriptor } = negotiated
  return descriptor.pluginId === jiraReadPluginDescriptor.pluginId &&
    sameVersion(descriptor.adapterVersion, compatibleHistoricalJiraAdapterVersion) &&
    JSON.stringify(descriptor.configurationFields) === JSON.stringify(jiraReadPluginDescriptor.configurationFields) &&
    negotiated.capabilities.length === 1 &&
    negotiated.capabilities[0]?.capabilityId === "entity.read" &&
    negotiated.capabilities[0].version === 1
}

/** Apply first-party runtime migration policy to persisted synchronization descriptors. */
export const supportsFirstPartySynchronization = (
  providerId: ProviderId,
  negotiated: typeof NegotiatedPluginDescriptorV1.Type
): boolean =>
  hasPluginCapability(negotiated, "sync.incremental", 1) ||
  (providerId === "jira" && isCompatibleHistoricalJiraDescriptor(negotiated))
