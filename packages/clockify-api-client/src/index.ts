/**
 * Root barrel export for `@knpkv/clockify-api-client` -- openapi-fetch + Effect Clockify REST client.
 *
 * @packageDocumentation
 */

export { ClockifyApiClient, type ClockifyApiClientShape, layer } from "./ClockifyApiClient.js"

export type {
  CreateTimeEntryParams,
  GetTimeEntriesParams,
  Project,
  StopTimeEntryParams,
  Tag,
  TimeEntry,
  TimeInterval,
  UpdateTimeEntryParams,
  User,
  Workspace
} from "./ClockifyApiClient.js"

export { ClockifyApiConfig, type ClockifyApiConfigShape } from "./ClockifyApiConfig.js"

export { ClockifyApiError } from "./ClockifyApiError.js"

export {
  FetchClientError,
  makeOpenApiFetchClient,
  type OpenApiFetchClient,
  type SuccessData,
  toEffect
} from "./OpenApiFetchClient.js"

// Re-export generated types
export type * as V1 from "./generated/index.js"
