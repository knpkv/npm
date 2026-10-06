import { Schema } from "effect"
import { WorkGoalObservedEntry, WorkSnapshots } from "./model.js"
import type {
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
  `github:${repository.toLowerCase()}#${pullRequest}`

/** The subject an agent's facts and failures are stored under; the host is case-insensitive. */
export const agentSubject = (host: string, agentId: string): string => `herdr:${host.toLowerCase()}/${agentId}`

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
      return observation.subject
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

const utf8 = new TextEncoder()
const encodedBytes = (value: Schema.Json): number => utf8.encode(JSON.stringify(value)).byteLength

const observedSomething = ({ agent, pullRequest, unknown }: WorkGoalObserved): boolean =>
  agent !== null || pullRequest !== null || unknown !== null

/**
 * Adds observed facts to the `now` window, for each goal something was
 * observed about. Earlier windows are history and stay as recorded. Entries
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
  // then (their confirmation clamped to t) and failures that had started.
  const asOf = snapshots.observedAt
  const factMap = bySubject(
    facts.filter(({ observedAt }) => observedAt <= asOf).map((fact) => ({
      ...fact,
      confirmedAt: Math.min(fact.confirmedAt, asOf)
    }))
  )
  const failureMap = bySubject(failures.filter(({ since }) => since <= asOf))
  if (factMap.size === 0 && failureMap.size === 0) return snapshots
  const candidates: ReadonlyArray<WorkGoalObservedEntry> = snapshots.now.goals.flatMap((goal) => {
    const observed = observeWith(goal, factMap, failureMap, snapshots.observedAt)
    return observedSomething(observed) ? [{ goalId: goal.id, ...observed }] : []
  })
  if (candidates.length === 0) return snapshots
  const encode = Schema.encodeSync(WorkSnapshots)
  const withEntries = (kept: ReadonlyArray<WorkGoalObservedEntry>): WorkSnapshots => {
    const omitted = candidates.length - kept.length
    if (omitted === 0) return { ...snapshots, now: { ...snapshots.now, observed: kept } }
    if (kept.length === 0) return { ...snapshots, now: { ...snapshots.now, observedOmitted: omitted } }
    return { ...snapshots, now: { ...snapshots.now, observed: kept, observedOmitted: omitted } }
  }
  // Estimate greedily, then check the real encoding and drop entries until it
  // fits; if not even the omission count fits, return the bare snapshots.
  let used = encodedBytes(encode(snapshots)) + 64
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
    if (kept.length === 0) return snapshots
    kept.pop()
  }
}
