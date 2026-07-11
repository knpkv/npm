/**
 * Root barrel export for the Schema-validated Effect Clockify client.
 *
 * @packageDocumentation
 */

export {
  ClockifyApiClient,
  type ClockifyApiClientShape,
  type ClockifyClientError,
  layer,
  make
} from "./ClockifyApiClient.js"

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

export * as ClockifyApi from "./generated/ClockifyApi.js"
