/**
 * The CLI's failures and the one line each prints. Every line names the setting or argument to fix
 * and never prints a key, an input path, the monitor origin or a bind host, any of which can name
 * something private; `scripts/packed.mjs` asserts this against the packed CLI. The one value echoed
 * is a malformed port. The key file `init` writes is named, since loading it needs the path.
 *
 *   yield* program.pipe(Effect.tapError((error) => Console.error(describeFailure(error))))
 *
 * @module
 */
import { Schema } from "effect"
import { CliError } from "effect/cli"
import { MAX_BYTES } from "./model.js"
import type { PublishError } from "./publisher.js"
import type { MonitorConfigurationError, MonitorSetting } from "./server.js"

/** A required environment variable is unset or empty. */
export class MissingSetting extends Schema.TaggedError<MissingSetting>()("MissingSetting", { name: Schema.String }) {}
/** An environment variable is set to something herdr-monitor cannot use. */
export class InvalidSetting extends Schema.TaggedError<InvalidSetting>()("InvalidSetting", {
  name: Schema.String,
  /** The value as set, for settings that are not secret; absent for keys. */
  value: Schema.optional(Schema.String)
}) {}
/** The snapshot file could not be read; `reason` is the platform's description. */
export class SnapshotFileUnreadable extends Schema.TaggedError<SnapshotFileUnreadable>()("SnapshotFileUnreadable", {
  file: Schema.String,
  reason: Schema.String
}) {}
/** The snapshot file is over `MAX_BYTES` before it is even parsed. */
export class SnapshotFileTooLarge extends Schema.TaggedError<SnapshotFileTooLarge>()("SnapshotFileTooLarge", {
  file: Schema.String,
  bytes: Schema.Number
}) {}
/** The snapshot file is not a snapshot; `reason` is the schema's description of the first problem. */
export class SnapshotFileInvalid extends Schema.TaggedError<SnapshotFileInvalid>()("SnapshotFileInvalid", {
  file: Schema.String,
  reason: Schema.String
}) {}
/** `serve` could not listen on its address. */
export class ListenFailed
  extends Schema.TaggedError<ListenFailed>()("ListenFailed", { address: Schema.String, reason: Schema.String })
{}
/** `serve` could not read the board's built web files. */
export class AssetsMissing extends Schema.TaggedError<AssetsMissing>()("AssetsMissing", { reason: Schema.String }) {}
/** `init` found keys already written; it never replaces them. */
export class KeysExist extends Schema.TaggedError<KeysExist>()("KeysExist", { path: Schema.String }) {}
/** `init` could not create its key file. */
export class KeysNotWritten
  extends Schema.TaggedError<KeysNotWritten>()("KeysNotWritten", { path: Schema.String, reason: Schema.String })
{}

export type CliFailure =
  | PublishError
  | MonitorConfigurationError
  | MissingSetting
  | InvalidSetting
  | SnapshotFileUnreadable
  | SnapshotFileTooLarge
  | SnapshotFileInvalid
  | ListenFailed
  | AssetsMissing
  | KeysExist
  | KeysNotWritten

/** A schema's multi-line description ("Missing key\n  at [\"boardId\"]") as one line. */
const oneLine = (text: string) => text.replace(/\s*\n\s*/gu, " ")

const settingVariable = {
  boardId: "MONITOR_BOARD",
  origin: "MONITOR_ORIGIN",
  publishToken: "MONITOR_PUBLISH_TOKEN",
  viewToken: "MONITOR_VIEW_TOKEN",
  independentTokens: "MONITOR_PUBLISH_TOKEN and MONITOR_VIEW_TOKEN"
} satisfies Record<MonitorSetting, string>

const settingRule = {
  boardId: "must be 1 to 48 lower-case letters, digits or hyphens, starting with a letter or digit.",
  origin: "must be https://host[:port] or http://127.0.0.1:port, with no path.",
  publishToken: "must be publish_ followed by 43 base64url characters. Run: herdr-monitor init",
  viewToken: "must be view_ followed by 43 base64url characters. Run: herdr-monitor init",
  independentTokens: "must be two different keys. Run: herdr-monitor init"
} satisfies Record<MonitorSetting, string>

/** What the monitor's answer means, for each status its publish route returns. */
const rejection = (status: number): string => {
  switch (status) {
    case 400:
      return "it is not a snapshot for this board now: boardId must match the server's MONITOR_BOARD, and sourceAt must be within the last five minutes"
    case 401:
      return "MONITOR_PUBLISH_TOKEN is not the server's publish key"
    case 404:
      return "the snapshot's boardId is not the server's MONITOR_BOARD"
    case 409:
      return "it already holds a snapshot with this sequence or a later one; publish a higher sequence"
    case 413:
      return `the snapshot is over ${MAX_BYTES} bytes`
    case 429:
      return "it accepts one snapshot per second; publish again in a moment"
    default:
      return "it gave no reason"
  }
}

/** One line for a failure, or `undefined` for a usage error effect/cli has already printed. */
export const describeFailure = (error: CliFailure | CliError.CliError): string | undefined => {
  if (CliError.isCliError(error)) return undefined
  switch (error._tag) {
    case "MissingSetting":
      return `${error.name} is not set. Run: herdr-monitor init, then load the file it writes.`
    case "InvalidSetting": {
      // Only a port is echoed: other settings can name private hosts.
      return error.name === "MONITOR_PORT"
        ? `${error.value === undefined ? error.name : `${error.name}=${error.value}`} is not a port number (1–65535).`
        : `${error.name} is not a value herdr-monitor can use.`
    }
    case "MonitorConfigurationError":
      return `${settingVariable[error.setting]} ${settingRule[error.setting]}`
    case "InvalidOrigin":
      return `MONITOR_ORIGIN ${settingRule.origin}`
    case "InvalidPublishToken":
      return `MONITOR_PUBLISH_TOKEN ${settingRule.publishToken}`
    case "InvalidSnapshot":
      return `The snapshot is not valid: ${oneLine(error.reason)}`
    case "SnapshotTooLarge":
      return `The snapshot is ${error.bytes} bytes; the limit is ${MAX_BYTES}.`
    case "MonitorUnreachable":
      return "Cannot reach the monitor at MONITOR_ORIGIN. Is herdr-monitor serve running there?"
    case "PublishTimedOut":
      return "The monitor at MONITOR_ORIGIN did not answer within 5 seconds."
    case "PublishRejected":
      return `The monitor refused the snapshot (HTTP ${error.status}): ${rejection(error.status)}.`
    case "SnapshotFileUnreadable":
      return `Cannot read the snapshot file: ${error.reason}.`
    case "SnapshotFileTooLarge":
      return `The snapshot file is ${error.bytes} bytes; a snapshot is at most ${MAX_BYTES}.`
    case "SnapshotFileInvalid":
      return `The snapshot file is not a valid snapshot: ${oneLine(error.reason)}`
    case "ListenFailed":
      return `Cannot listen on MONITOR_BIND:MONITOR_PORT (${error.reason}). Set another MONITOR_PORT, or stop what holds it.`
    case "AssetsMissing":
      return "The board's web files are missing from this install. Rebuild: pnpm --filter @knpkv/herdr-monitor build"
    case "KeysExist":
      return `${error.path} already holds monitor keys; init never replaces them. Delete it first to make new ones.`
    case "KeysNotWritten":
      return `Cannot write ${error.path}: ${error.reason}.`
  }
}
