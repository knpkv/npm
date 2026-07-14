/** Durable application adapters for the authenticated HTTP API. @packageDocumentation */
export { mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"
export { makeMediaReads, mediaReadsLayer } from "./mediaReads.js"
export {
  listPluginConnectionSummaries,
  makePluginAdministration,
  pluginAdministrationLayer
} from "./pluginAdministration.js"
export { makePortfolioSnapshots, portfolioSnapshotsLayer } from "./portfolioSnapshots.js"
export {
  reconcileFakeReleaseProjection,
  recoverFakeReleaseProjection,
  synchronizeFakeRelease,
  synchronizeFakeReleaseFromMap
} from "./releaseSynchronization.js"
export type {
  ReleaseSynchronizationFailure,
  ReleaseSynchronizationInput,
  ReleaseSynchronizationOutcome
} from "./releaseSynchronization.js"
