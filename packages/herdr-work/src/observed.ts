import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Schema } from "effect"
import { WorkActivityProvenance, WorkGoalObservedEntry, WorkSnapshots } from "./model.js"
import type {
  WorkActivity,
  WorkAgentObservation,
  WorkDisplayState,
  WorkGoal,
  WorkGoalObserved,
  WorkObservation,
  WorkObservedFact,
  WorkObservedFailure,
  WorkPullRequestObservation
} from "./model.js"

/**
 * The subject a pull request's facts and failures are stored under. GitHub
 * owner and repository names are case-insensitive (and ASCII), so they are
 * lowercased: `Knpkv/npm` and `knpkv/npm` are one subject.
 */
export const pullRequestSubject = (repository: string, pullRequest: number): string =>
  `github:${asciiLower(repository)}#${pullRequest}`

/** The subject an agent's facts and failures are stored under; the host is case-insensitive. */
export const agentSubject = (host: string, agentId: string): string => `herdr:${asciiLower(host)}/${agentId}`

/**
 * Lowercases ASCII letters only. Full Unicode lowercasing can lengthen a
 * string (`İ` becomes two code units), which would push a bounded identity
 * past its limit; hosts and GitHub names compare case-insensitively in ASCII.
 */
export const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

const githubSubject = /^github:([^#]+)#([1-9][0-9]*)$/
const herdrSubject = /^herdr:([^/]+)\/(.+)$/

/**
 * The canonical form of a subject a failed read names, so it lands on the
 * same row as that subject's facts; null when the subject does not belong to
 * its source (a `github` failure must name `github:<repo>#<n>`, a `herdr`
 * failure `herdr:<host>/<agentId>`). `git` subjects are kept as given.
 */
export const canonicalSubject = (source: "github" | "herdr" | "git", subject: string): string | null => {
  if (source === "git") return subject
  if (source === "github") {
    const match = githubSubject.exec(subject)
    return match?.[1] === undefined || match[2] === undefined ? null : pullRequestSubject(match[1], Number(match[2]))
  }
  const match = herdrSubject.exec(subject)
  return match?.[1] === undefined || match[2] === undefined ? null : agentSubject(match[1], match[2])
}

/**
 * The key one observation is stored under: one pull request, or one agent on
 * one host. An `unknown` observation names the subject it failed to read, so
 * a failure lands on the same subject as that subject's facts.
 */
export const observationSubject = (observation: WorkObservation): string => {
  switch (observation._tag) {
    case "pull_request":
      return pullRequestSubject(observation.repository, observation.pullRequest)
    case "agent":
      return agentSubject(observation.host, observation.agentId)
    case "unknown":
      return canonicalSubject(observation.source, observation.subject) ?? observation.subject
  }
}

/** An owner whose agent has been gone this long, on unfinished work, is flagged stale. */
export const staleOwnerAfterMillis = 24 * 60 * 60 * 1_000

const terminalStates: ReadonlySet<WorkDisplayState> = new Set(["completed", "deployed", "abandoned"])

const reviewUrl = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/

/** The goal's own subjects: its pull request (from `review.url`) and its owner's agent (or connect target). */
const goalSubjects = (goal: WorkGoal) => {
  const match = reviewUrl.exec(goal.review?.url ?? "")
  // Older goals carry only a connect target; it names the same agent.
  const owner = goal.agentHierarchy?.agent ?? goal.connectTarget
  return {
    agent: owner === undefined || owner === null ? null : agentSubject(owner.host, owner.agentId),
    pullRequest: match?.[1] === undefined || match[2] === undefined
      ? null
      : pullRequestSubject(match[1], Number(match[2]))
  }
}

/** The subject of the pull request a goal's `review.url` names, or null when it names none. */
export const goalPullRequestSubject = (goal: WorkGoal): string | null => goalSubjects(goal).pullRequest

const terminalPullRequestState = (pullRequest: WorkPullRequestObservation): WorkDisplayState | null =>
  pullRequest.state === "merged" ? "completed" : pullRequest.state === "closed" ? "abandoned" : null

const agentState = (agent: WorkAgentObservation): WorkDisplayState | null =>
  agent.status === "working" || agent.status === "blocked" ? agent.status : null

const observeWith = (
  goal: WorkGoal,
  facts: ReadonlyMap<string, WorkObservedFact>,
  failures: ReadonlyMap<string, WorkObservedFailure>,
  now: number
): WorkGoalObserved => {
  const subjects = goalSubjects(goal)
  const pullRequestFact = subjects.pullRequest === null ? undefined : facts.get(subjects.pullRequest)
  const agentFact = subjects.agent === null ? undefined : facts.get(subjects.agent)
  const pullRequest = pullRequestFact?.observation._tag === "pull_request"
    ? {
      confirmedAt: pullRequestFact.confirmedAt,
      fact: pullRequestFact.observation,
      observedAt: pullRequestFact.observedAt
    }
    : null
  const agent = agentFact?.observation._tag === "agent"
    ? { confirmedAt: agentFact.confirmedAt, fact: agentFact.observation, observedAt: agentFact.observedAt }
    : null
  const unknown = [subjects.pullRequest, subjects.agent]
    .flatMap((subject) => {
      const failure = subject === null ? undefined : failures.get(subject)
      return failure === undefined || subject === null ? [] : [{
        lastGoodAt: facts.get(subject)?.confirmedAt ?? null,
        reason: failure.reason,
        since: failure.since,
        source: failure.source
      }]
    })
    .reduce<WorkGoalObserved["unknown"]>(
      (oldest, next) => oldest === null || next.since < oldest.since ? next : oldest,
      null
    )
  const displayState: WorkDisplayState = terminalStates.has(goal.state)
    ? goal.state
    : (pullRequest === null ? null : terminalPullRequestState(pullRequest.fact)) ??
      (goal.state === "blocked" ? "blocked" : null) ??
      (agent === null ? null : agentState(agent.fact)) ??
      (pullRequest === null ? goal.state : "review")
  const stale = !terminalStates.has(displayState) && agent !== null && agent.fact.status === "gone" &&
    now - agent.observedAt > staleOwnerAfterMillis
  return { agent, displayState, pullRequest, stale, unknown }
}

const bySubject = <A extends { readonly subject: string }>(rows: ReadonlyArray<A>): ReadonlyMap<string, A> =>
  new Map(rows.map((row) => [row.subject, row]))

/**
 * Overlays the latest observed facts and current read failures on one goal
 * for display, matched through the goal's own subjects. Precedence: a
 * recorded terminal state, then a terminal pull request, then the owner's
 * blocker, then the agent's working/blocked status, then an open pull request
 * (review), then the goal's own state. The goal itself is never changed.
 */
export const observeGoal = (
  goal: WorkGoal,
  facts: ReadonlyArray<WorkObservedFact>,
  failures: ReadonlyArray<WorkObservedFailure>,
  now: number
): WorkGoalObserved => observeWith(goal, bySubject(facts), bySubject(failures), now)

/**
 * The encoded size the overlay may bring a snapshot up to: the Fleet response
 * limit less the newline the HTTP route appends after the JSON body.
 */
export const workSnapshotBudgetBytes = fleetResponseBodyMaxBytes - "\n".length

const utf8 = new TextEncoder()
const encodedBytes = (value: Schema.Json): number => utf8.encode(JSON.stringify(value)).byteLength

const observedSomething = ({ agent, pullRequest, unknown }: WorkGoalObserved): boolean =>
  agent !== null || pullRequest !== null || unknown !== null

/**
 * Adds observed facts to the `now` window, for each goal something was
 * observed about (`observed` is present, possibly empty, whenever it fits). Earlier windows are history and stay as recorded. Entries
 * are kept in the window's goal order (most recently updated first) while the
 * encoded snapshots stay within `maxBytes`; the rest are counted in
 * `observedOmitted`, never silently dropped.
 */
export const withObservedFacts = (
  snapshots: WorkSnapshots,
  facts: ReadonlyArray<WorkObservedFact>,
  failures: ReadonlyArray<WorkObservedFailure>,
  maxBytes: number
): WorkSnapshots => {
  // A snapshot at time t shows only what was known at t: facts first seen by
  // then, with the last confirmation made by then (the first sighting, also a
  // real read, when the latest is later), and failures whose latest failed
  // read, and so their reason, was known by then.
  const asOf = snapshots.observedAt
  const factMap = bySubject(
    facts.filter(({ observedAt }) => observedAt <= asOf).map((fact) => ({
      ...fact,
      confirmedAt: fact.confirmedAt <= asOf ? fact.confirmedAt : fact.observedAt
    }))
  )
  const failureMap = bySubject(failures.filter(({ lastAt }) => lastAt <= asOf))
  const candidates: ReadonlyArray<WorkGoalObservedEntry> = snapshots.now.goals.flatMap((goal) => {
    const observed = observeWith(goal, factMap, failureMap, snapshots.observedAt)
    return observedSomething(observed) ? [{ goalId: goal.id, ...observed }] : []
  })
  const encode = Schema.encodeSync(WorkSnapshots)
  // Any overlay already on the snapshots is replaced, never added to.
  const { observed: _previous, observedOmitted: _previousOmitted, ...bareNow } = snapshots.now
  const bare: WorkSnapshots = { ...snapshots, now: bareNow }
  const withEntries = (kept: ReadonlyArray<WorkGoalObservedEntry>): WorkSnapshots => {
    const omitted = candidates.length - kept.length
    const now = { ...bareNow, observed: kept }
    return { ...bare, now: omitted === 0 ? now : { ...now, observedOmitted: omitted } }
  }
  // Estimate greedily, then check the real encoding and drop entries until it
  // fits. `observed` is always present, empty when nothing was observed; if
  // not even that fits, the snapshots carry no overlay keys at all, which a
  // reader treats as "live state not available".
  let used = encodedBytes(encode(bare)) + 64
  const kept: Array<WorkGoalObservedEntry> = []
  for (const entry of candidates) {
    const bytes = encodedBytes(Schema.encodeSync(WorkGoalObservedEntry)(entry)) + 1
    if (used + bytes > maxBytes) break
    kept.push(entry)
    used += bytes
  }
  for (;;) {
    const result = withEntries(kept)
    if (encodedBytes(encode(result)) <= maxBytes) return result
    if (kept.length === 0) return bare
    kept.pop()
  }
}

const sameActivity = (left: WorkActivity, right: WorkActivity): boolean =>
  left.id === right.id && left.kind === right.kind && left.summary === right.summary &&
  left.occurredAt === right.occurredAt

/** One activity an approved Fleet job wrote on a goal. */
export interface WorkApprovedActivity {
  readonly goalId: string
  readonly activityId: string
  readonly approvalJobId: string
}

/** The reconciler's checkpoints, and their activities, use this id prefix. */
export const reconcilerEventPrefix = "reconciler."

/**
 * Adds who wrote each non-owner activity to the `now` window: the reconciler
 * or an approved job. Goals are covered whole, in the window's goal order,
 * while the encoded snapshots stay within `maxBytes`; `activityProvenanceGoals`
 * names the covered ones, so a missing activity of a covered goal is the
 * owner's and an uncovered goal is unknown, never guessed.
 */
export const withActivityProvenance = (
  snapshots: WorkSnapshots,
  approvals: ReadonlyArray<WorkApprovedActivity>,
  reconcilerEvents: ReadonlyArray<{ readonly goalId: string; readonly eventId: string }>,
  activityOrigins: ReadonlyMap<string, { readonly eventId: string; readonly activity: WorkActivity }>,
  maxBytes: number
): WorkSnapshots => {
  const reconciler = new Set(reconcilerEvents.map(({ eventId, goalId }) => `${goalId}\u0000${eventId}`))
  const approvalJob = new Map(
    approvals.map(({ activityId, approvalJobId, goalId }) => [`${goalId}\u0000${activityId}`, approvalJobId])
  )
  const encode = Schema.encodeSync(WorkSnapshots)
  // Room for the three keys on top of the bare snapshots.
  let used = encodedBytes(encode(snapshots)) + 128
  const provenance: Array<WorkActivityProvenance> = []
  const covered: Array<string> = []
  for (const goal of snapshots.now.goals) {
    const entries = (goal.activity ?? []).flatMap((activity): ReadonlyArray<WorkActivityProvenance> => {
      // Authorship comes from what wrote the activity, never from its id alone,
      // and holds only while the activity still reads exactly as written.
      const key = `${goal.id}\u0000${activity.id}`
      const origin = activityOrigins.get(key)
      if (origin === undefined || !sameActivity(origin.activity, activity)) return []
      const job = approvalJob.get(key)
      // An approved operation writes its activity in its own checkpoint, whose
      // event id is the activity id; any other origin is not its write.
      if (job !== undefined && origin.eventId === activity.id) {
        return [{ activityId: activity.id, approvalJobId: job, goalId: goal.id, provenance: "approval" }]
      }
      return reconciler.has(`${goal.id}\u0000${origin.eventId}`)
        ? [{ activityId: activity.id, approvalJobId: null, goalId: goal.id, provenance: "reconciler" }]
        : []
    })
    const bytes = encodedBytes(goal.id) + 3 +
      entries.reduce((sum, entry) => sum + encodedBytes(Schema.encodeSync(WorkActivityProvenance)(entry)) + 1, 0)
    // Goals are covered in order; once one doesn't fit, the rest stay uncovered.
    if (used + bytes > maxBytes) break
    for (const entry of entries) provenance.push(entry)
    covered.push(goal.id)
    used += bytes
  }
  // Check the real encoding and uncover whole goals from the end until it
  // fits; if not even empty lists fit, carry no provenance (all unknown).
  for (;;) {
    const uncovered = snapshots.now.goals.length - covered.length
    const now = {
      ...snapshots.now,
      activityProvenance: provenance.filter(({ goalId }) => covered.includes(goalId)),
      activityProvenanceGoals: covered
    }
    const result = { ...snapshots, now: uncovered === 0 ? now : { ...now, activityProvenanceOmitted: uncovered } }
    if (encodedBytes(encode(result)) <= maxBytes) return result
    if (covered.length === 0) return snapshots
    covered.pop()
  }
}
