/**
 * Failed fleet jobs for the Needs-you inbox, from each host's recent history: {@link fleetFailures}.
 *
 * **Mental model**
 *
 * - **Every failure in the window counts, whoever asked.** A job's actor can't tell an agent from a person (the hub's
 *   own agents and a person on its loopback page are both `local`; agents on fleet machines submit under the owner's
 *   tailnet login), so no actor filter is applied. `approved` says whether a person approved it, and a page claims
 *   "after you approved" only then.
 * - **A later success settles a failure.** When the same host ran a job with the same payload hash later and it
 *   succeeded, the failure was retried outside the inbox and drops out.
 * - **Bounded.** Each host contributes its window (newest first, a few pages); the merged list keeps the newest
 *   {@link fleetFailuresMax} and says `truncated` past that. A host whose history can't be read is named in `hosts`.
 *
 * @module
 */
import { jobOutcome } from "@knpkv/herdr-fleet/job-outcome"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import type { NeedsYouFailureCandidate, NeedsYouFailureReason } from "./module-needs-you.js"

export const fleetFailuresWindowMillis = 7 * 24 * 60 * 60 * 1_000
export const fleetFailuresMax = 20

/** One host's history window, or why it couldn't be read. */
export type HostHistory =
  | { readonly _tag: "Read"; readonly host: string; readonly records: ReadonlyArray<JobRecord> }
  | { readonly _tag: "Unreadable"; readonly host: string; readonly reason: typeof NeedsYouFailureReason.Type }

export interface FleetFailures {
  readonly failures: ReadonlyArray<NeedsYouFailureCandidate>
  readonly truncated: boolean
  readonly hosts: ReadonlyArray<{ readonly host: string; readonly reason: typeof NeedsYouFailureReason.Type }>
  readonly lastDecisionAt: number | null
}

const hostFailures = (host: string, records: ReadonlyArray<JobRecord>): ReadonlyArray<NeedsYouFailureCandidate> =>
  records.flatMap((record) => {
    const outcome = jobOutcome(record)
    if (outcome._tag !== "Failed" && outcome._tag !== "FailedAfterApproval") return []
    const settled = records.some((later) =>
      later.hash === record.hash && later.status === "succeeded" && later.createdAt > record.createdAt
    )
    return settled ? [] : [{
      sourceKey: `failed:${host.toLowerCase()}:${record.id}`,
      host,
      jobId: record.id,
      kind: record.payload.kind,
      actor: record.actor,
      createdAt: record.createdAt,
      failedAt: record.updatedAt,
      reason: outcome.reason,
      approved: outcome._tag === "FailedAfterApproval"
    }]
  })

const decisionsOf = (record: JobRecord): ReadonlyArray<number> =>
  [record.approvedAt, record.rejectedAt].flatMap((at) => at === undefined || at === null ? [] : [at])

/** `since` bounds both the failures and the last decision; records older than it are ignored. */
export const fleetFailures = (histories: ReadonlyArray<HostHistory>, since: number): FleetFailures => {
  const hosts: Array<{ readonly host: string; readonly reason: typeof NeedsYouFailureReason.Type }> = []
  const failures: Array<NeedsYouFailureCandidate> = []
  let lastDecisionAt: number | null = null
  for (const history of histories) {
    if (history._tag === "Unreadable") {
      hosts.push({ host: history.host, reason: history.reason })
      continue
    }
    const recent = history.records.filter((record) => record.createdAt >= since)
    for (const failure of hostFailures(history.host, recent)) failures.push(failure)
    for (const at of recent.flatMap(decisionsOf)) {
      if (at >= since && (lastDecisionAt === null || at > lastDecisionAt)) lastDecisionAt = at
    }
  }
  failures.sort((a, b) => b.failedAt - a.failedAt || (a.sourceKey < b.sourceKey ? -1 : 1))
  return {
    failures: failures.slice(0, fleetFailuresMax),
    truncated: failures.length > fleetFailuresMax,
    hosts,
    lastDecisionAt
  }
}
