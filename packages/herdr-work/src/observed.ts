import type {
  WorkAgentObservation,
  WorkDisplayState,
  WorkGoal,
  WorkGoalObserved,
  WorkGoalObservedEntry,
  WorkObservation,
  WorkObservedFact,
  WorkObservedFailure,
  WorkPullRequestObservation,
  WorkSnapshots
} from "./model.js"

/** The subject a pull request's facts and failures are stored under. */
export const pullRequestSubject = (repository: string, pullRequest: number): string =>
  `github:${repository}#${pullRequest}`

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

/** The goal's own subjects: its pull request (from `review.url`) and its owner's agent. */
const goalSubjects = (goal: WorkGoal) => {
  const match = reviewUrl.exec(goal.review?.url ?? "")
  const owner = goal.agentHierarchy?.agent
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

/** Adds observed facts to the `now` window. Earlier windows are history and stay as recorded. */
export const withObservedFacts = (
  snapshots: WorkSnapshots,
  facts: ReadonlyArray<WorkObservedFact>,
  failures: ReadonlyArray<WorkObservedFailure>
): WorkSnapshots => {
  if (facts.length === 0 && failures.length === 0) return snapshots
  const factMap = bySubject(facts)
  const failureMap = bySubject(failures)
  const observed: ReadonlyArray<WorkGoalObservedEntry> = snapshots.now.goals.map((goal) => ({
    goalId: goal.id,
    ...observeWith(goal, factMap, failureMap, snapshots.observedAt)
  }))
  return { ...snapshots, now: { ...snapshots.now, observed } }
}
