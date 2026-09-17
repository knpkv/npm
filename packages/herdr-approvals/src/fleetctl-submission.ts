import { type JobRecord } from "@knpkv/herdr-fleet"
import { Effect, Result } from "effect"

interface DetailedFailure {
  readonly detail: string
}

export type HostSubmissionOutcome =
  | {
    readonly approvalUrl: string | null
    readonly approvalUrlError: string | null
    readonly host: string
    readonly record: JobRecord
  }
  | {
    readonly error: string
    readonly host: string
    readonly record: null
  }

export const submitToHost = Effect.fn("Fleetctl.submitToHost")(function*<
  SubmissionError extends DetailedFailure,
  SubmissionRequirements,
  ApprovalError extends DetailedFailure,
  ApprovalRequirements
>(
  host: string,
  submission: Effect.Effect<JobRecord, SubmissionError, SubmissionRequirements>,
  approvalPage: Effect.Effect<string, ApprovalError, ApprovalRequirements>
): Effect.fn.Return<
  HostSubmissionOutcome,
  never,
  SubmissionRequirements | ApprovalRequirements
> {
  const submitted = yield* Effect.result(submission)
  if (Result.isFailure(submitted)) {
    return { error: submitted.failure.detail, host, record: null }
  }
  if (submitted.success.status !== "pending_approval") {
    return {
      approvalUrl: null,
      approvalUrlError: null,
      host,
      record: submitted.success
    }
  }
  const resolved = yield* Effect.result(approvalPage)
  return Result.isSuccess(resolved)
    ? {
      approvalUrl: resolved.success,
      approvalUrlError: null,
      host,
      record: submitted.success
    }
    : {
      approvalUrl: null,
      approvalUrlError: resolved.failure.detail,
      host,
      record: submitted.success
    }
})
