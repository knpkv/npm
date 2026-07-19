/** Durable application adapters for the authenticated HTTP API. @packageDocumentation */
export { authorizedSharesLayer, makeAuthorizedShares } from "./authorizedShares.js"
export { deliveryGraphInspectionLayer, makeDeliveryGraphInspection } from "./deliveryGraphInspection.js"
export { mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"
export { liveEventsLayer, makeLiveEvents } from "./liveEvents.js"
export { makeMediaReads, mediaReadsLayer } from "./mediaReads.js"
export {
  listFirstPartyServiceMetadata,
  listPluginConnectionSummaries,
  makePluginAdministration,
  makePluginAdministrationWithConnections,
  makePluginAdministrationWithOAuth,
  pluginAdministrationLayer,
  pluginAdministrationLayerWithConnections,
  pluginAdministrationOAuthLayer,
  pluginAdministrationOAuthLayerWithConnections
} from "./pluginAdministration.js"
export { makePortfolioSnapshots, portfolioSnapshotsLayer } from "./portfolioSnapshots.js"
export {
  digestEnvironmentReadinessCandidate,
  digestReadinessRule,
  digestReleaseReadinessCandidate,
  ReadinessDigestError
} from "./readinessDigests.js"
export { makeRelationshipRepairProposals, relationshipRepairProposalsLayer } from "./relationshipRepairProposals.js"
export {
  makeReleaseAgentTurns,
  type ReleaseAgentRuntimeOptions,
  releaseAgentTurnsLayer,
  releaseAgentUnavailableLayer
} from "./releaseAgent.js"
export {
  reconcileFakeReleaseProjection,
  reconcileFakeReleaseSyncAttempts,
  recoverFakeReleaseProjection,
  synchronizeFakeRelease,
  synchronizeFakeReleaseFromMap
} from "./releaseSynchronization.js"
export type {
  ReleaseSynchronizationFailure,
  ReleaseSynchronizationInput,
  ReleaseSynchronizationOutcome
} from "./releaseSynchronization.js"
export { makeTimelineExportAudits, timelineExportAuditsLayer } from "./timelineExportAudits.js"
export { makeTimelineReads, timelineReadsLayer } from "./timelineReads.js"
