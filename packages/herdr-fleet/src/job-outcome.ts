/**
 * What became of a job, and why it failed, in words a person reads: {@link jobOutcome} and {@link jobFailureReason}.
 *
 * **Mental model**
 *
 * - **An outcome is the status plus whether a person approved it.** A failed or interrupted job that someone approved
 *   is `FailedAfterApproval`, so a page can say "Failed after you approved" only when that is true.
 * - **A reason is a closed class, never the raw error.** The raw error stays in the record for the detail view; the
 *   class picks the one line a person reads ({@link jobFailureReasonText}). Anything unrecognised is `other`.
 * - **A structured agent error wins over text.** Agent commands fail with a JSON envelope
 *   (`{"error":{"code":…,"message":…}}`), matched by its `code`; text patterns only read plain strings, so a message
 *   that merely mentions a code word is not misread. An envelope with a code of no class of its own still has its
 *   text matched.
 *
 * @module
 */
import { Option, Schema } from "effect"
import type { JobRecord } from "./model.js"

export const JobFailureReason = Schema.Literals([
  "agent_timeout",
  "agent_not_found",
  "agent_blocked",
  "hub_restarted",
  "host_status_unreadable",
  "not_on_main",
  "sudo_password",
  "build_failed",
  "disk_full",
  "no_reason",
  "other"
])
export type JobFailureReason = typeof JobFailureReason.Type

/** The line a person reads for each reason; `other` pairs with the raw error in the detail. */
export const jobFailureReasonText = {
  agent_timeout: "The agent didn't report back in time",
  agent_not_found: "The agent it was sent to is gone",
  agent_blocked: "The agent was blocked waiting for input",
  hub_restarted: "The hub restarted while it ran",
  host_status_unreadable: "The coordinator couldn't read host status",
  not_on_main: "The checkout wasn't on main",
  sudo_password: "sudo asked for a password",
  build_failed: "The Nix build failed",
  disk_full: "The disk was full",
  no_reason: "It stopped without a reason",
  other: "It failed"
} satisfies Record<JobFailureReason, string>

export type JobOutcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Succeeded" }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "FailedAfterApproval"; readonly reason: JobFailureReason }
  | { readonly _tag: "Failed"; readonly reason: JobFailureReason }

const AgentErrorEnvelope = Schema.fromJsonString(Schema.Struct({
  error: Schema.Struct({ code: Schema.String })
}))
const decodeEnvelope = Schema.decodeUnknownOption(AgentErrorEnvelope)

const envelopeCodes: ReadonlyMap<string, JobFailureReason> = new Map([
  ["timeout", "agent_timeout"],
  ["agent_not_found", "agent_not_found"],
  ["agent_blocked", "agent_blocked"]
])

/** Plain-text classes, first match wins. */
const textClasses: ReadonlyArray<readonly [RegExp, JobFailureReason]> = [
  [/hostd restarted while this job was running/, "hub_restarted"],
  [/malformed host status/, "host_status_unreadable"],
  [/checkout is not on main/, "not_on_main"],
  [/sudo: a password is required|sudo: a terminal is required to read the password/, "sudo_password"],
  [/Disk quota exceeded|No space left on device/, "disk_full"],
  [/error: Cannot build '/, "build_failed"]
]

const exitPrefix = /^command exited with code \d+:?\s*/
/** Only an error class name, optionally with stack frames: nothing a person can act on. */
const bareErrorName = /^[A-Z]\w*Error:?(\s+at\s+\S+(\s+\(\S+\))?)*\s*$/

export const jobFailureReason = (error: string | null): JobFailureReason => {
  const detail = (error ?? "").trim().replace(exitPrefix, "")
  if (detail === "" || bareErrorName.test(detail)) return "no_reason"
  const envelope = decodeEnvelope(detail.slice(Math.max(detail.indexOf("{"), 0)))
  const coded = Option.flatMapNullishOr(envelope, ({ error }) => envelopeCodes.get(error.code))
  if (Option.isSome(coded)) return coded.value
  return textClasses.find(([pattern]) => pattern.test(detail))?.[1] ?? "other"
}

export const jobOutcome = (
  record: Pick<JobRecord, "status" | "approvedAt" | "error">
): JobOutcome => {
  switch (record.status) {
    case "pending_approval":
    case "queued":
      return { _tag: "Pending" }
    case "running":
      return { _tag: "Running" }
    case "succeeded":
      return { _tag: "Succeeded" }
    case "rejected":
      return { _tag: "Rejected" }
    case "expired":
      return { _tag: "Expired" }
    case "failed":
    case "interrupted": {
      const reason = jobFailureReason(record.error)
      return record.approvedAt === undefined || record.approvedAt === null
        ? { _tag: "Failed", reason }
        : { _tag: "FailedAfterApproval", reason }
    }
  }
}
