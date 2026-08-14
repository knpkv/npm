/**
 * Root barrel export for the Schema-validated Effect Clockify client.
 *
 * @packageDocumentation
 */

export {
  ClockifyApiClient,
  type ClockifyApiClientContract,
  type ClockifyClientError,
  layer,
  make
} from "./ClockifyApiClient.js"

export type {
  AuthenticatedClockifyApi,
  CreateTimeEntryParams,
  GetTimeEntriesParams,
  GetTimeEntryParams,
  Project,
  StopTimeEntryParams,
  Tag,
  TimeEntry,
  TimeInterval,
  UpdateTimeEntryParams,
  User,
  Workspace,
  WorkspaceUser
} from "./ClockifyApiClient.js"

export { ClockifyApiConfig, type ClockifyApiConfigContract } from "./ClockifyApiConfig.js"

export * as ClockifyApi from "./generated/ClockifyApi.js"
