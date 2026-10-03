/** Loaded with the first API response, keeping validation out of the initial shell bundle. */
import { SessionAgentSettings } from "@knpkv/jira-clockify/agent/agentSettings.js"
import * as Schema from "effect/Schema"
import {
  DescribeRowResponse,
  DescribeSavedEntryResponse,
  OwnershipResult,
  SavedWeek,
  StandingResult,
  UpdateSavedEntryResponse,
  WeekReadEvent,
  WriteResult
} from "../shared/contracts.js"

export const decodeWeekEvent = Schema.decodeUnknownPromise(Schema.fromJsonString(WeekReadEvent))
export const decodeWriteResult = Schema.decodeUnknownPromise(WriteResult)
export const decodeOwnershipResult = Schema.decodeUnknownPromise(OwnershipResult)
export const decodeStandingResult = Schema.decodeUnknownPromise(StandingResult)
export const decodeDescription = Schema.decodeUnknownPromise(DescribeRowResponse)
export const decodeSavedEntryDescription = Schema.decodeUnknownPromise(DescribeSavedEntryResponse)
export const decodeSavedEntryUpdate = Schema.decodeUnknownPromise(UpdateSavedEntryResponse)

export const decodeBootstrap = Schema.decodeUnknownPromise(Schema.Struct({ csrfToken: Schema.String }))
export const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ message: Schema.optional(Schema.String), maxSeconds: Schema.optional(Schema.Number) })
  )
)

// HttpApi canonicalizes optional undefined values as null on the JSON wire.
export const decodeSavedWeek = Schema.decodeUnknownPromise(Schema.toCodecJson(SavedWeek))

export const decodeAgentSettings = Schema.decodeUnknownPromise(SessionAgentSettings)
