import type { NegotiatedPluginDescriptorV1 } from "../../domain/plugins/descriptor.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import { hasPluginCapability } from "./negotiation.js"

const FIRST_PARTY_SYNC_STREAMS: Readonly<Record<ProviderId, string>> = {
  codecommit: "pull-requests",
  codepipeline: "executions",
  jira: "project-issues",
  clockify: "time-entries",
  confluence: "pages"
}

/** Resolve the production synchronization stream owned by a first-party provider. */
export const firstPartySyncStreamKey = (providerId: ProviderId): string => FIRST_PARTY_SYNC_STREAMS[providerId]

/** Apply first-party runtime migration policy to persisted synchronization descriptors. */
export const supportsFirstPartySynchronization = (
  _providerId: ProviderId,
  negotiated: typeof NegotiatedPluginDescriptorV1.Type
): boolean => hasPluginCapability(negotiated, "sync.incremental", 1)
