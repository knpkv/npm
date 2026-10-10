import { Button, StateLabel, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import { Icon, type RlyIconName } from "@knpkv/rly/foundations"
import {
  DecisionBar,
  Hero,
  HeroWord,
  Region,
  type RlyDecisionBarState,
  type RlyTimelineEvent
} from "@knpkv/rly/patterns"
import { useEffect, useRef, useState, type ReactElement } from "react"
import type {
  DeliveryStage,
  WorkActivity,
  WorkAgentObservation,
  WorkApprovalTarget,
  WorkDisplayState,
  WorkGoal,
  WorkGoalFamilyGroup,
  WorkGoalObserved,
  WorkPullRequestObservation,
  WorkRequest,
  WorkReview,
  WorkSnapshot,
  WorkSnapshots,
  WorkSnapshotWindow,
  WorkBlocker
} from "./model.js"
import { activityShownOf } from "./model.js"
import { decodeWorkBoardNavigationGoal, encodeWorkBoardNavigationGoal } from "./navigation.js"
import { workRequestClockText, workRequestDecidability, type WorkRequestDecisions } from "./request-decision.js"
import { displayStateOf, observedFor } from "./display-state.js"
import {
  type WorkTriageSummary,
  workGoalFinishedAt,
  workTriage,
  workTriageGroups,
  workTriageGroupTitle,
  workTriageSentence,
  type WorkTriageTense
} from "./work-triage.js"

export type { WorkRequestAnswer, WorkRequestDecision, WorkRequestDecisions } from "./request-decision.js"
/** The request clock's wording ("52s", "4m 12s", "11m", "expiring"), shared with hosts that show the same clocks. */
export { workRequestClockText } from "./request-decision.js"

const windows: ReadonlyArray<WorkSnapshotWindow> = ["now", "day", "week", "month"]
const initialVisibleGoalCount = 10
const selectedGoalFragment = "work-selected-goal"
const goalStates: ReadonlyArray<WorkGoal["state"]> = [
  "planned",
  "working",
  "blocked",
  "review",
  "deployed",
  "completed",
  "abandoned"
]
const statusFilters: ReadonlyArray<"all" | WorkGoal["state"]> = ["all", ...goalStates]

const windowLabel = {
  now: "Now",
  day: "24 hours ago",
  week: "7 days ago",
  month: "30 days ago"
} satisfies Readonly<Record<WorkSnapshotWindow, string>>

const statePresentation = {
  planned: { label: "Planned", tone: "neutral" },
  working: { label: "Working", tone: "progress" },
  blocked: { label: "Blocked", tone: "critical" },
  review: { label: "In review", tone: "caution" },
  deployed: { label: "Deployed", tone: "positive" },
  completed: { label: "Completed", tone: "positive" },
  abandoned: { label: "Abandoned", tone: "neutral" }
} satisfies Readonly<Record<WorkGoal["state"], { readonly label: string; readonly tone: RlyStateTone }>>

/** Every state the tab can show: the recorded ones, plus `abandoned`, which only an observation can show today. */
const displayPresentation = {
  ...statePresentation,
  abandoned: { label: "Abandoned", tone: "neutral" }
} satisfies Readonly<Record<WorkDisplayState, { readonly label: string; readonly tone: RlyStateTone }>>

const sourceLabel = {
  github: "GitHub",
  herdr: "herdr",
  git: "git"
} satisfies Readonly<Record<NonNullable<WorkGoalObserved["unknown"]>["source"], string>>

const pullRequestStateLabel = {
  open: "open",
  merged: "merged",
  closed: "closed without merging"
} satisfies Readonly<Record<WorkPullRequestObservation["state"], string>>

const checksLabel = {
  none: "no checks",
  pending: "checks running",
  passing: "checks passing",
  failing: "checks failing"
} satisfies Readonly<Record<WorkPullRequestObservation["checks"], string>>

const agentStatusLabel = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  gone: "gone"
} satisfies Readonly<Record<WorkAgentObservation["status"], string>>

const deliveryLabel = {
  local: "In progress",
  review: "In review",
  pull_request: "Pull request",
  merged: "Merged",
  deployed: "Deployed"
} satisfies Readonly<Record<DeliveryStage, string>>

const reviewPresentation = {
  not_requested: { label: "Not requested", evidence: "no review yet", tone: "neutral" },
  requested: { label: "Requested", evidence: "review requested", tone: "caution" },
  changes_requested: { label: "Changes requested", evidence: "changes requested", tone: "critical" },
  approved: { label: "Approved", evidence: "approved", tone: "positive" }
} satisfies Readonly<
  Record<
    NonNullable<WorkReview>["state"],
    {
      readonly label: string
      readonly evidence: string
      readonly tone: RlyStateTone
    }
  >
>

const checksPresentation = {
  none: { label: "no checks", tone: "neutral" },
  pending: { label: "checks running", tone: "progress" },
  passing: { label: "checks passing", tone: "positive" },
  failing: { label: "checks failing", tone: "critical" }
} satisfies Readonly<
  Record<WorkPullRequestObservation["checks"], { readonly label: string; readonly tone: RlyStateTone }>
>

const stateIcon = {
  neutral: "minus",
  positive: "check",
  critical: "alert",
  caution: "clock",
  progress: "loader"
} satisfies Readonly<Record<RlyStateTone, RlyIconName>>

const requestPresentation = {
  open: { label: "Open", tone: "caution" },
  approved: { label: "Approved", tone: "positive" },
  rejected: { label: "Rejected", tone: "critical" },
  fulfilled: { label: "Fulfilled", tone: "positive" }
} satisfies Readonly<Record<WorkRequest["state"], { readonly label: string; readonly tone: RlyStateTone }>>

const formatTimestamp = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp)

/** The board's timestamp formatter also supplies compact clocks. */
const formatClock = (timestamp: number): string =>
  formatTimestamp(timestamp).split(", ").at(-1) ?? formatTimestamp(timestamp)

const ageOf = (timestamp: number, asOf: number): string => {
  const minutes = Math.max(0, Math.floor((asOf - timestamp) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`
  const days = Math.floor(minutes / 1_440)
  return `${days} ${days === 1 ? "day" : "days"} ago`
}

const formatSpend = (goal: WorkGoal): string =>
  goal.spend === null
    ? "Not recorded"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: goal.spend.currency
      }).format(goal.spend.minorUnits / 100)

const blockersFor = (goal: WorkGoal): ReadonlyArray<WorkBlocker> => {
  if (goal.blockers !== undefined) return goal.blockers
  return goal.blocker === null ? [] : [goal.blocker]
}

const activityFor = (goal: WorkGoal): ReadonlyArray<WorkActivity> => goal.activity ?? []

const requestsFor = (goal: WorkGoal): ReadonlyArray<WorkRequest> => goal.requests ?? []

/** Renders the persisted approval deep link after its origin is bound at ingress. */
const exactLink = (target: WorkApprovalTarget, label: string): ReactElement => (
  <a className="work-exact-link" href={target.url}>
    {label}
  </a>
)

/** Renders the persisted review destination without rewriting its credential-free URL. */
const reviewLink = (url: string): ReactElement => (
  <a className="work-exact-link" href={url}>
    Open review
  </a>
)

const reviewLabel = (review: WorkReview | null | undefined): ReactElement => {
  if (review === undefined || review === null) {
    return <Text tone="secondary">No review recorded.</Text>
  }
  return (
    <StateLabel
      label={reviewPresentation[review.state].label}
      size="compact"
      tone={reviewPresentation[review.state].tone}
    />
  )
}

/** PR delivery includes review; local work includes it only when recorded. Abandoned work stops at its last step. */
const GoalProgress = ({
  goal,
  observed
}: {
  readonly goal: WorkGoal
  readonly observed: WorkGoalObserved | null
}): ReactElement => {
  const shown = observed?.displayState ?? goal.state
  const merged = observed?.pullRequest?.fact.state === "merged" || goal.delivery === "merged"
  const hasPullRequest = merged || observed?.pullRequest != null || goal.delivery === "pull_request"
  const hasReview =
    hasPullRequest ||
    goal.delivery === "review" ||
    shown === "review" ||
    (goal.review != null && goal.review.state !== "not_requested")
  const finished = !hasPullRequest && (shown === "completed" || shown === "deployed")
  const names = hasReview
    ? ["Planned", "In progress", "In review", hasPullRequest ? "Merged" : "Done"]
    : ["Planned", "In progress", "Done"]
  const finalStep = names.length - 1
  const current = merged || finished ? finalStep : hasReview ? 2 : shown === "planned" ? 0 : 1
  const abandoned = shown === "abandoned"
  return (
    <section aria-labelledby="work-delivery-title" className="work-delivery">
      <h3 className="work-group-title" id="work-delivery-title">
        Delivery
      </h3>
      <ol aria-label={`Delivery of ${goal.title}`} className="work-row-progress" data-steps={names.length} role="list">
        {names.map((name, index) => (
          <li
            aria-current={!abandoned && index === current ? "step" : undefined}
            aria-label={abandoned && index === current ? `${name}, abandoned here` : undefined}
            data-reached={index < current || (!abandoned && index === current)}
            data-stopped={abandoned && index === current}
            data-tone={displayPresentation[shown].tone}
            key={name}
          >
            <span aria-hidden="true" className="work-step-number">
              {index + 1}
            </span>
            <span className="work-step-name">{name}</span>
            {abandoned && index === current ? (
              <span className="work-step-status">Abandoned</span>
            ) : !abandoned && index === current && current !== finalStep ? (
              <StateLabel
                icon={stateIcon[displayPresentation[shown].tone]}
                label="Now"
                size="compact"
                tone={displayPresentation[shown].tone}
              />
            ) : (
              <span className="work-step-status">
                {index < current || (!abandoned && index === current) ? "Done" : "Not yet"}
              </span>
            )}
          </li>
        ))}
      </ol>
      {hasPullRequest ? null : (
        <Text tone="secondary" variant="meta">
          No pull request
        </Text>
      )}
    </section>
  )
}

/** CI and review come only from an observed PR. Its confirmation time says when those facts were last read. */
const GoalEvidence = ({
  goal,
  observed
}: {
  readonly goal: WorkGoal
  readonly observed: WorkGoalObserved | null
}): ReactElement | null => {
  const pullRequest = observed?.pullRequest
  if (pullRequest == null && goal.delivery !== "pull_request" && goal.delivery !== "merged") return null
  const ci =
    pullRequest == null
      ? ({ label: "checks unknown", tone: "neutral" } satisfies { readonly label: string; readonly tone: RlyStateTone })
      : checksPresentation[pullRequest.fact.checks]
  const review =
    pullRequest == null
      ? ({ evidence: "review unknown", tone: "neutral" } satisfies {
          readonly evidence: string
          readonly tone: RlyStateTone
        })
      : reviewPresentation[pullRequest.fact.review]
  return (
    <div className="work-row-evidence">
      <span className="work-evidence-chip">
        <StateLabel className="work-ci-fact" icon={stateIcon[ci.tone]} label={ci.label} size="compact" tone={ci.tone} />
        <span className="work-row-read">
          {pullRequest == null ? (
            " · Not read"
          ) : (
            <>
              {observed?.unknown?.source === "github" ? " · last read " : " · read "}
              <time
                dateTime={new Date(pullRequest.confirmedAt).toISOString()}
                title={formatTimestamp(pullRequest.confirmedAt)}
              >
                {formatClock(pullRequest.confirmedAt)}
              </time>
            </>
          )}
        </span>
      </span>
      <span className="work-evidence-chip">
        <StateLabel
          className="work-review-fact"
          icon={stateIcon[review.tone]}
          label={review.evidence}
          size="compact"
          tone={review.tone}
        />
        <span className="work-row-read">
          {pullRequest == null ? (
            " · Not read"
          ) : (
            <>
              {observed?.unknown?.source === "github" ? " · last read" : " · read"}{" "}
              <time
                dateTime={new Date(pullRequest.confirmedAt).toISOString()}
                title={formatTimestamp(pullRequest.confirmedAt)}
              >
                {formatClock(pullRequest.confirmedAt)}
              </time>
            </>
          )}
        </span>
      </span>
    </div>
  )
}

/** A row's caption: the one fact that explains its group, and whether that fact blocks. */
/** The one line under a goal row; `blocking` gives it the blocked ink. */
interface WorkRowCaption {
  readonly text: string
  readonly blocking: boolean
}

const rowCaption = (
  goal: WorkGoal,
  observed: WorkGoalObserved | null,
  decisions: WorkRequestDecisions | undefined
): WorkRowCaption => {
  const open = requestsFor(goal).filter(({ state }) => state === "open")
  if (open.length > 0) {
    // The soonest clock among requests this page can decide, beside the request it belongs to.
    const soonest = open
      .map((request) => ({ decidability: workRequestDecidability(request, decisions), request }))
      .flatMap(({ decidability, request }) =>
        decidability._tag === "Here" && decidability.expiresAt !== null
          ? [{ expiresAt: decidability.expiresAt, request }]
          : []
      )
      .toSorted((left, right) => left.expiresAt - right.expiresAt)[0]
    const clock =
      soonest === undefined || decisions === undefined
        ? ""
        : `, ${workRequestClockText(soonest.expiresAt, decisions.now)}${soonest.expiresAt > decisions.now ? " left" : ""}`
    return {
      blocking: false,
      text: open.length === 1 ? `${open[0]?.summary ?? ""}${clock}` : `${open.length} requests need approval${clock}`
    }
  }
  const blockers = blockersFor(goal)
  if (blockers.length > 0) return { blocking: true, text: blockers[0]?.summary ?? "Blocked" }
  if (observed?.stale === true && observed.agent !== null) {
    return { blocking: false, text: `Owner gone since ${formatClock(observed.agent.observedAt)}` }
  }
  if (observed?.unknown != null) {
    return {
      blocking: false,
      text: `Couldn't read ${sourceLabel[observed.unknown.source]} since ${formatTimestamp(observed.unknown.since)}`
    }
  }
  const latest = activityFor(goal).toSorted((a, b) => b.occurredAt - a.occurredAt)[0]
  if (latest !== undefined) return { blocking: false, text: `${latest.summary}, ${formatTimestamp(latest.occurredAt)}` }
  return { blocking: false, text: `${goal.owner.name}, ${deliveryLabel[goal.delivery].toLowerCase()}` }
}

/** The caption under the hero: the request waiting longest, or the latest change. */
const summaryCaption = (
  summary: WorkTriageSummary,
  tense: WorkTriageTense,
  snapshot: WorkSnapshot
): string | undefined => {
  switch (summary._tag) {
    case "Attention":
      return summary.oldestRequest === null
        ? undefined
        : `${tense === "present" ? "Waiting longest" : "Waiting longest then"}: ${summary.oldestRequest.request.summary} on ${summary.oldestRequest.goal.title}${tense === "past" ? "." : `, requested ${ageOf(summary.oldestRequest.request.requestedAt, snapshot.asOf)}.`}`
    case "Clear": {
      const rows = workTriage(snapshot).rows
      const planned = rows.filter((row) => row.group === "planned").length
      const finished = rows
        .filter((row) => row.group === "done" || row.group === "earlier")
        .map(({ goal }) => ({ goal, at: workGoalFinishedAt(goal, observedFor(snapshot, goal.id)) }))
        .toSorted((left, right) => right.at - left.at)[0]
      return `${summary.moving} ${summary.moving === 1 ? "goal" : "goals"} ${tense === "past" ? "were " : ""}moving, ${planned} planned.${finished === undefined ? "" : ` Last finished: ${finished.goal.title}, ${ageOf(finished.at, snapshot.asOf)}.`}`
    }
    case "Empty":
      return undefined
  }
}

/**
 * What the timeline shows for one goal, newest first: the owner's recorded activity, plus what the
 * reconciler observed (a pull request, the owner's agent) and any source it could not read. Observed
 * events keep source detail and provenance in their accessible descriptions beside terse visible titles.
 */
const timelineFor = (goal: WorkGoal, observed: WorkGoalObserved | null): ReadonlyArray<RlyTimelineEvent> => {
  const recorded = activityFor(goal).map((entry): RlyTimelineEvent => ({
    actorKind: "system",
    dateTime: new Date(entry.occurredAt).toISOString(),
    detail: activityKindLabel[entry.kind],
    id: entry.id,
    time: formatClock(entry.occurredAt),
    title: entry.summary
  }))
  const seen: Array<RlyTimelineEvent> = []
  if (observed?.pullRequest != null) {
    const { confirmedAt, fact, observedAt } = observed.pullRequest
    const at = fact.closedAt ?? observedAt
    seen.push({
      actorKind: "system",
      dateTime: new Date(at).toISOString(),
      detail: `${checksLabel[fact.checks]}, last read ${formatTimestamp(confirmedAt)}`,
      id: `observed-pull-request-${fact.repository}-${fact.pullRequest}`,
      provenance: { kind: "auto", label: "Observed on GitHub" },
      time: formatClock(at),
      title: `Pull request #${fact.pullRequest} ${pullRequestStateLabel[fact.state]}`
    })
  }
  if (observed?.agent != null) {
    const { confirmedAt, fact, observedAt } = observed.agent
    seen.push({
      actorKind: "agent",
      dateTime: new Date(observedAt).toISOString(),
      detail: `${fact.host}, last read ${formatTimestamp(confirmedAt)}`,
      id: `observed-agent-${fact.host}-${fact.agentId}`,
      provenance: { kind: "auto", label: "Observed in herdr" },
      time: formatClock(observedAt),
      title: `Agent ${agentStatusLabel[fact.status]}`
    })
  }
  if (observed?.unknown != null) {
    const { lastGoodAt, reason, since, source } = observed.unknown
    seen.push({
      actorKind: "system",
      dateTime: new Date(since).toISOString(),
      detail: reason,
      id: `observed-unknown-${source}`,
      provenance: {
        kind: "unknown",
        label: lastGoodAt === null ? "Never read" : `Last good read ${formatTimestamp(lastGoodAt)}`
      },
      time: formatClock(since),
      title: `Couldn't read ${sourceLabel[source]}`
    })
  }
  return [...recorded, ...seen].toSorted((left, right) => Date.parse(right.dateTime) - Date.parse(left.dateTime))
}

/**
 * How this page shows a request it can decide. `Bar` while there is something to decide or wait for;
 * `Settled` once the snapshot proves the outcome, when buttons would decide nothing: the request
 * then reads as its title and state word, and only a refusal adds a line. `Elsewhere` keeps the hub
 * link. The hub decides expiry, never this page's clock.
 */
type RequestDecision =
  | { readonly _tag: "Elsewhere" }
  | { readonly _tag: "Bar"; readonly bar: ReactElement }
  | { readonly _tag: "Settled"; readonly announcement: string; readonly refusal: string | null }

const requestDecisionFor = (
  request: WorkRequest,
  decisions: WorkRequestDecisions | undefined,
  historical: boolean
): RequestDecision => {
  // A recorded open request is never a live approval target; no current queue, clock or handler reaches this bar.
  if (historical && request.state === "open" && request.approvalTarget !== null) {
    return {
      _tag: "Bar",
      bar: (
        <DecisionBar
          onApprove={() => undefined}
          onReject={() => undefined}
          state={{ _tag: "off", reason: "Decisions are off in the past." }}
          target={request.summary}
        />
      )
    }
  }
  const decidability = workRequestDecidability(request, decisions)
  if (decidability._tag === "Elsewhere" || decisions === undefined) return { _tag: "Elsewhere" }
  const { expiresAt, jobId } = decidability
  const answer = decisions.answer?.jobId === jobId ? decisions.answer : null
  // Once the request has left the hub's queue, the snapshot's outcome is the proven one.
  if (request.state !== "open") {
    return {
      _tag: "Settled",
      announcement: `${request.summary}: ${requestPresentation[request.state].label}.`,
      refusal: answer?.outcome === "refused" ? answer.text : null
    }
  }
  const pending = decisions.expiresAt(jobId) !== undefined
  const state: RlyDecisionBarState =
    decisions.sending?.jobId === jobId
      ? { _tag: "sending", action: decisions.sending.decision }
      : decisions.sending !== null
        ? { _tag: "off", reason: "Another decision is waiting for the hub." }
        : // The hub took a decision; the host's pending list has not caught up yet, so nothing else may be sent.
          answer?.outcome === "accepted" && pending
          ? { _tag: "off", reason: "Waiting for the hub's queue to update." }
          : pending
            ? { _tag: "ready" }
            : { _tag: "off", reason: "Left the hub's queue." }
  const decide = (decision: "approve" | "reject") => () => {
    if (state._tag === "ready") decisions.onDecision({ decision, jobId })
  }
  return {
    _tag: "Bar",
    bar: (
      <DecisionBar
        {...(expiresAt === null || !pending
          ? {}
          : {
              clock: `${workRequestClockText(expiresAt, decisions.now)}${expiresAt > decisions.now ? " left" : ""}`
            })}
        onApprove={decide("approve")}
        onReject={decide("reject")}
        state={state}
        {...(answer === null ? {} : { status: answer.text })}
        target={request.summary}
      />
    )
  }
}

/** One request in a goal's detail: its title once, then the bar, the hub link or the outcome. */
const RequestItem = ({
  asOf,
  decisions,
  externalLinks,
  historical,
  request
}: {
  readonly decisions: WorkRequestDecisions | undefined
  readonly externalLinks: "disabled" | "enabled"
  readonly historical: boolean
  readonly asOf: number
  readonly request: WorkRequest
}): ReactElement => {
  const decision = requestDecisionFor(
    request,
    externalLinks === "enabled" ? decisions : undefined,
    historical && externalLinks === "enabled"
  )
  const presentation = requestPresentation[request.state]
  return (
    <li>
      {/* While a bar is shown its target names the request, so the heading would say it twice. */}
      {decision._tag === "Bar" ? null : (
        <span className="work-request-heading">
          <StateLabel
            className="work-row-state"
            icon={request.state === "rejected" ? "close" : stateIcon[presentation.tone]}
            label={presentation.label}
            size="compact"
            tone={presentation.tone}
          />
          <Text as="strong" variant="meta">
            {request.summary}
          </Text>
          {request.state === "open" ? null : (
            <Text tone="secondary" variant="meta">
              requested {ageOf(request.requestedAt, asOf)}
            </Text>
          )}
        </span>
      )}
      {request.state === "open" ? (
        <div className="work-request-meta">
          {decision._tag === "Bar" ? <StateLabel icon="clock" label="Open" size="compact" tone="caution" /> : null}
          <Text tone="secondary" variant="meta">
            requested {ageOf(request.requestedAt, asOf)}
          </Text>
        </div>
      ) : null}
      {decision._tag === "Bar" ? (
        decision.bar
      ) : decision._tag === "Settled" ? (
        decision.refusal === null ? null : (
          <Text tone="secondary" variant="meta">
            {decision.refusal}
          </Text>
        )
      ) : request.state !== "open" ? null : request.approvalTarget === null ? (
        <Text tone="secondary" variant="meta">
          No approval link recorded.
        </Text>
      ) : externalLinks === "disabled" ? (
        <Text tone="secondary" variant="meta">
          Approve this on the hub ({request.approvalTarget.host}).
        </Text>
      ) : (
        exactLink(request.approvalTarget, `Approve on ${request.approvalTarget.host}`)
      )}
      {/*
        Mounted from the bar onwards, so the outcome is announced when the bar gives way to it; the
        heading's state word already shows it, so it is for screen readers only.
      */}
      {decision._tag === "Elsewhere" ? null : (
        <p aria-atomic="true" className="work-request-announcement" role="status">
          {decision._tag === "Settled" ? decision.announcement : ""}
        </p>
      )}
    </li>
  )
}

/** Everything about one goal, in reading order: what it is, where it is, what blocks it, what happened. */
const GoalDetail = ({
  closeControl,
  decisions,
  externalLinks,
  goal,
  snapshot
}: {
  readonly closeControl: ReactElement
  readonly decisions: WorkRequestDecisions | undefined
  readonly externalLinks: "disabled" | "enabled"
  readonly goal: WorkGoal
  readonly snapshot: WorkSnapshot
}): ReactElement => {
  const family = familyForGoal(snapshot, goal.id)
  const observed = observedFor(snapshot, goal.id)
  const shown = observed?.displayState ?? goal.state
  const activity = timelineFor(goal, observed)
  const readDay = new Date(snapshot.observedAt).toDateString()
  const agent = goal.agentHierarchy?.agent
  const agentName = agent?.name ?? goal.owner.name
  const agentIdentity = agent === undefined ? agentName : `${agent.host} / ${agentName}`
  // Only the live window carries the overlay; there "nothing observed" is itself a reading.
  const overlay = snapshot.observed !== undefined
  // A goal-level approval target (older checkpoints carry one without requests); skipped when a
  // request already links the same approval.
  const goalApproval =
    goal.approvalTarget === undefined ||
    goal.approvalTarget === null ||
    requestsFor(goal).some(({ approvalTarget }) => approvalTarget?.url === goal.approvalTarget?.url)
      ? null
      : goal.approvalTarget
  return (
    <div className="work-detail">
      <div className="work-detail-heading">
        <Text as="h3" variant="card-title">
          {goal.title}
        </Text>
        <StateLabel
          icon={stateIcon[displayPresentation[shown].tone]}
          label={displayPresentation[shown].label}
          size="compact"
          tone={displayPresentation[shown].tone}
        />
        {shown === goal.state ? null : (
          <Text className="work-fact-note" tone="secondary" variant="meta">
            Observed; recorded as {statePresentation[goal.state].label.toLowerCase()}
          </Text>
        )}
      </div>
      {observed?.stale === true && observed.agent !== null ? (
        <p className="work-note" data-tone="held">
          <b>Owner gone</b> since {formatClock(observed.agent.observedAt)}: this unfinished goal has no live agent.
        </p>
      ) : null}
      <GoalProgress goal={goal} observed={observed} />
      {overlay ? <GoalEvidence goal={goal} observed={observed} /> : null}
      <dl className="work-facts">
        <div>
          <dt>Pull request</dt>
          <dd>
            {observed?.pullRequest == null
              ? observed === null && snapshot.observedOmitted !== undefined
                ? "Not in this read: live state was trimmed to the most recently updated goals"
                : "None yet"
              : `#${observed.pullRequest.fact.pullRequest} ${pullRequestStateLabel[observed.pullRequest.fact.state]}${observed.stale ? `, ${checksLabel[observed.pullRequest.fact.checks]}` : ""}`}
            {observed?.pullRequest == null ? null : (
              <Text as="p" className="work-fact-note" tone="secondary" variant="meta">
                Observed on GitHub
              </Text>
            )}
          </dd>
        </div>
        {goal.review == null ? null : (
          <div>
            <dt>Review</dt>
            <dd>
              {reviewLabel(goal.review)}
              {overlay ? null : ", as recorded"}
              {goal.review?.url === null || goal.review?.url === undefined ? null : externalLinks ===
                "disabled" ? null : (
                <> {reviewLink(goal.review.url)}</>
              )}
              {goal.review?.summary === null || goal.review?.summary === undefined ? null : (
                <Text tone="secondary" variant="meta">
                  {goal.review.summary}
                </Text>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Repository</dt>
          <dd>{goal.repository.repository}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{goal.repository.branch}</dd>
        </div>
        {goal.owner.name === agentName ? null : (
          <div>
            <dt>Owner</dt>
            <dd>{goal.owner.name}</dd>
          </div>
        )}
        <div>
          <dt>Agent</dt>
          <dd>
            {observed?.agent == null
              ? `${agentIdentity}, as recorded`
              : `${agentIdentity}, ${agentStatusLabel[observed.agent.fact.status]}${observed.agent.fact.status === "gone" ? ` since ${formatClock(observed.agent.observedAt)}` : ""}`}
            {observed?.agent == null ? null : (
              <Text as="p" className="work-fact-note" tone="secondary" variant="meta">
                Observed in herdr
              </Text>
            )}
            {goal.agentHierarchy?.agent.relationship === undefined || goal.agentHierarchy === null
              ? null
              : `, ${goal.agentHierarchy.agent.relationship.relation} from ${goal.agentHierarchy.agent.relationship.parentAgentId}`}
          </dd>
        </div>
        {goal.spend === null ? null : (
          <div>
            <dt>Spend</dt>
            <dd>{formatSpend(goal)}</dd>
          </div>
        )}
      </dl>
      {goal.detail === goal.title ? null : <Text tone="secondary">{goal.detail}</Text>}
      {observed?.unknown == null ? null : (
        <p className="work-note" data-tone="unknown">
          <b>Couldn't read {sourceLabel[observed.unknown.source]}</b> since {formatTimestamp(observed.unknown.since)}:{" "}
          {observed.unknown.reason}.{" "}
          {observed.unknown.lastGoodAt === null
            ? "It has never been read, so nothing here comes from it."
            : `Facts from it are as of ${formatTimestamp(observed.unknown.lastGoodAt)}.`}
        </p>
      )}
      {blockersFor(goal).map((blocker) => (
        <p className="work-note" data-tone="blocked" key={`${blocker.since}-${blocker.summary}`}>
          <b>Blocked</b> since {formatTimestamp(blocker.since)}: {blocker.summary}
        </p>
      ))}
      <section aria-labelledby="work-requests-title" className="work-detail-section">
        <h3 className="work-group-title" id="work-requests-title">
          Requests
        </h3>
        {requestsFor(goal).length === 0 ? (
          <Text tone="secondary">
            {goal.requests === undefined ? "No requests recorded." : "No outstanding requests."}
          </Text>
        ) : (
          <ul className="work-detail-list">
            {requestsFor(goal).map((request) => (
              <RequestItem
                asOf={snapshot.asOf}
                decisions={decisions}
                externalLinks={externalLinks}
                historical={snapshot.window !== "now"}
                key={request.id}
                request={request}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="work-activity-title" className="work-detail-section">
        <h3 className="work-group-title" id="work-activity-title">
          Activity
        </h3>
        {activityOmittedFor(snapshot, goal) === 0 ? null : (
          <Text tone="secondary" variant="meta">
            {activityShownOf(goal.activity?.length ?? 0, activityOmittedFor(snapshot, goal))}
          </Text>
        )}
        {activity.length === 0 ? (
          <Text tone="secondary">{goal.activity === undefined ? "No activity recorded." : "Activity is clear."}</Text>
        ) : (
          <ol aria-label={`Activity on ${goal.title}`} className="work-activity">
            {activity.map((event) => {
              const descriptionId = `work-activity-${goal.id}-${event.id}`
              const eventAt = Date.parse(event.dateTime)
              const date = new Date(eventAt).toDateString() === readDay ? null : formatTimestamp(eventAt)
              return (
                <li
                  aria-describedby={descriptionId}
                  className="work-activity-row"
                  data-rly-timeline-event-id={event.id}
                  key={event.id}
                >
                  <time dateTime={event.dateTime}>{event.time}</time>
                  <span>{event.title}</span>
                  <span
                    className="work-accessible-detail"
                    data-rly-timeline-provenance={event.provenance?.kind}
                    id={descriptionId}
                  >
                    {event.detail}
                    {event.provenance === undefined ? "" : `. ${event.provenance.label}`}
                    {date === null ? "" : `. ${date}`}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      {family === null ? null : (
        <section aria-labelledby="work-family-title" className="work-detail-section">
          <h3 className="work-group-title" id="work-family-title">
            Superseded history
          </h3>
          <details className="work-family-history">
            <summary>Show {family.superseded.length} superseded</summary>
            <ul className="work-detail-list">
              {family.superseded.map((entry) => (
                <li key={entry.id}>
                  <span className="work-request-heading">
                    <Text>{entry.title}</Text>
                    <span className="work-row-state" data-tone={statePresentation[entry.state].tone}>
                      {statePresentation[entry.state].label}
                    </span>
                  </span>
                  <Text tone="secondary" variant="meta">
                    {entry.summary}, {formatTimestamp(entry.updatedAt)}
                  </Text>
                  {blockersFor(entry).map((blocker) => (
                    <Text key={`${blocker.since}-${blocker.summary}`} tone="secondary" variant="meta">
                      Blocked since {formatTimestamp(blocker.since)}: {blocker.summary}
                    </Text>
                  ))}
                  {entry.review === undefined || entry.review === null ? null : (
                    <Text tone="secondary" variant="meta">
                      Review {reviewPresentation[entry.review.state].label.toLowerCase()}
                      {entry.review.summary === null ? "" : `: ${entry.review.summary}`}
                    </Text>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      <div className="work-links">
        {goal.connectTarget === null ? (
          <Text tone="secondary">No exact Connect target recorded.</Text>
        ) : externalLinks === "disabled" ? (
          <Text tone="secondary" variant="meta">
            Connect target recorded.
          </Text>
        ) : (
          // The agent's stage first: who it is and what it's saying, with its terminal one tap away.
          <a className="work-connect-link" href={`${goal.connectTarget.url}&open=stage`}>
            {observed?.stale === true ? "Find" : "Open"} {agentName} in Connect
            <Icon decorative name="arrow-right" size="small" />
          </a>
        )}
        {goalApproval === null ? null : externalLinks === "disabled" ? (
          <Text tone="secondary" variant="meta">
            Approval target recorded on {goalApproval.host}.
          </Text>
        ) : (
          exactLink(goalApproval, `Open ${goalApproval.host} approval`)
        )}
        {closeControl}
      </div>
    </div>
  )
}

const activityKindLabel = {
  note: "Note",
  status: "Status",
  blocker: "Blocker",
  request: "Request",
  review: "Review",
  shipment: "Shipment"
} satisfies Readonly<Record<WorkActivity["kind"], string>>

const snapshotFor = (snapshots: WorkSnapshots, window: WorkSnapshotWindow): WorkSnapshot => snapshots[window]

/** How many older activities the snapshot left out of this goal's timeline. */
const activityOmittedFor = (snapshot: WorkSnapshot, goal: WorkGoal): number => snapshot.activityOmitted?.[goal.id] ?? 0

/** Header read time and live-read limitations. Omitted goal counts belong to the board. */
const headerSentences = (
  window: WorkSnapshotWindow,
  snapshot: WorkSnapshot,
  host: string | undefined
): ReadonlyArray<string> => {
  const when = `Durable goals${host === undefined ? "" : ` on ${host}`}, read ${formatClock(snapshot.observedAt)}.`
  const live =
    window !== "now"
      ? []
      : snapshot.observed === undefined
        ? [
            "Live state not available: this hub sends no observed facts, so owner and pull request lines show only what each goal recorded. Update herdr-work on the hub to see them."
          ]
        : snapshot.observedOmitted === undefined
          ? []
          : [`Live state shown for the most recently updated goals; ${String(snapshot.observedOmitted)} left out.`]
  return [when, ...live]
}

const familyForGoal = (snapshot: WorkSnapshot, goalId: string): WorkGoalFamilyGroup | null =>
  (snapshot.families ?? []).find((group) => group.canonicalGoalId === goalId) ?? null

const familyLabelForGoal = (snapshot: WorkSnapshot, goal: WorkGoal): string | null => {
  const group = familyForGoal(snapshot, goal.id)
  if (group === null) return null
  const count = group.superseded.length
  return `${count} superseded`
}

const withFragment = (href: string, fragment: string): string => {
  const fragmentIndex = href.indexOf("#")
  return `${fragmentIndex === -1 ? href : href.slice(0, fragmentIndex)}#${fragment}`
}

export const WorkBoard = ({
  decisions,
  externalLinks = "enabled",
  host,
  initialGoalId,
  initialWindow = "now",
  navigation,
  snapshots
}: {
  readonly snapshots: WorkSnapshots
  /**
   * Lets the reader decide approval requests in place, with their clock. Omit it (the LAN view, a
   * host that is not the hub) and every request links to the hub instead.
   */
  readonly decisions?: WorkRequestDecisions
  readonly externalLinks?: "disabled" | "enabled"
  /** The application supplies its own host; goal owners may be on other hosts. Omit when unknown. */
  readonly host?: string
  readonly initialGoalId?: string | null
  readonly initialWindow?: WorkSnapshotWindow
  readonly navigation?: (selection: { readonly goalId: string | null; readonly window: WorkSnapshotWindow }) => string
}): ReactElement => {
  const [window, setWindow] = useState<WorkSnapshotWindow>(initialWindow)
  const snapshot = snapshotFor(snapshots, window)
  const directInitialGoal = snapshot.goals.find(({ id }) => id === initialGoalId)
  const boardNavigation = directInitialGoal === undefined ? decodeWorkBoardNavigationGoal(initialGoalId ?? null) : null
  const requestedInitialSelectedId = boardNavigation === null ? (initialGoalId ?? null) : boardNavigation.goalId
  const initialStatusFilter = boardNavigation?.statusFilter ?? "all"
  const requestedInitialSelectedGoal = snapshot.goals.find(({ id }) => id === requestedInitialSelectedId)
  // A link's filter names the state its row showed, so restore it against the same displayed state.
  const initialSelectedGoal =
    requestedInitialSelectedGoal !== undefined &&
    (initialStatusFilter === "all" || displayStateOf(snapshot, requestedInitialSelectedGoal) === initialStatusFilter)
      ? requestedInitialSelectedGoal
      : undefined
  const initialSelectedId = initialSelectedGoal?.id ?? null
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [detailsOpen, setDetailsOpen] = useState(
    initialSelectedGoal !== undefined &&
      (boardNavigation?.detailsOpen ?? (initialGoalId !== undefined && initialGoalId !== null))
  )
  const [statusFilter, setStatusFilter] = useState<"all" | WorkGoal["state"]>(initialStatusFilter)
  const [visibleGoalCount, setVisibleGoalCount] = useState(boardNavigation?.visibleGoalCount ?? initialVisibleGoalCount)
  const detailsRef = useRef<HTMLElement | null>(null)
  const selectedLinkRowRef = useRef<HTMLAnchorElement | null>(null)
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const triage = workTriage(snapshot)
  const finishedGoalCount = triage.rows.filter(
    ({ displayState }) => displayState === "completed" || displayState === "deployed" || displayState === "abandoned"
  ).length
  const hasGoalOmissions = (snapshot.goalsOmitted ?? 0) > 0 || (snapshot.finishedOmitted ?? 0) > 0
  const finishedCount =
    finishedGoalCount > 0 || (snapshot.finishedOmitted ?? 0) > 0 ? (
      <Text className="work-finished-count" tone="secondary" variant="meta">
        {finishedGoalCount} finished {finishedGoalCount === 1 ? "goal" : "goals"}
        {(snapshot.finishedOmitted ?? 0) > 0 ? ` · ${snapshot.finishedOmitted} older not shown` : null}
      </Text>
    ) : null
  // The overlay by goal, built once per snapshot: rows, captions and filters all read it.
  const overlay: ReadonlyMap<string, WorkGoalObserved> = new Map(
    (snapshot.observed ?? []).map((entry) => [entry.goalId, entry])
  )
  const observedOf = (goal: WorkGoal): WorkGoalObserved | null => overlay.get(goal.id) ?? null
  const shownOf = (goal: WorkGoal): WorkDisplayState => observedOf(goal)?.displayState ?? goal.state
  // A historical window is the state as of its time; say so, never in the present tense.
  const tense: WorkTriageTense = window === "now" ? "present" : "past"
  const sentence = workTriageSentence(triage.summary, tense)
  const heroFact =
    triage.summary._tag === "Attention" && triage.summary.blocked > 0 ? (
      <>
        {sentence.slice(0, -`${triage.summary.blocked} blocked`.length)}
        <HeroWord tone="blocked">{`${triage.summary.blocked} blocked`}</HeroWord>
      </>
    ) : tense === "past" && triage.summary._tag === "Attention" ? (
      <>
        {sentence.split("needed you")[0]}
        <HeroWord tone="held">needed you</HeroWord>
      </>
    ) : triage.summary._tag === "Empty" && tense === "past" ? (
      "Nothing needed you"
    ) : (
      sentence
    )
  const groupById = new Map(triage.rows.map((row) => [row.goal.id, row.group]))
  const ordered = triage.rows.map((row) => row.goal)
  // Filters match what each row shows: the observed state where there is one.
  const filteredGoals = statusFilter === "all" ? ordered : ordered.filter((goal) => shownOf(goal) === statusFilter)
  const selectedFilteredGoalIndex = filteredGoals.findIndex(({ id }) => id === selectedId)
  const selected = filteredGoals.find(({ id }) => id === selectedId) ?? null
  const visibleGoalStart =
    selectedFilteredGoalIndex < visibleGoalCount ? 0 : selectedFilteredGoalIndex - visibleGoalCount + 1
  const visibleGoals = filteredGoals.slice(visibleGoalStart, visibleGoalStart + visibleGoalCount)
  const visibleGroups = workTriageGroups
    .map((group) => ({ group, goals: visibleGoals.filter(({ id }) => groupById.get(id) === group) }))
    .filter(({ goals }) => goals.length > 0)
  // Opening a goal moves focus to its heading, so the detail is announced by name.
  useEffect(() => {
    if (detailsOpen) detailsRef.current?.querySelector<HTMLElement>("h2")?.focus()
  }, [detailsOpen, selectedId])
  useEffect(() => {
    if (
      navigation !== undefined &&
      !detailsOpen &&
      selectedId !== null &&
      document.location.hash === `#${selectedGoalFragment}`
    ) {
      selectedLinkRowRef.current?.focus()
    }
  }, [detailsOpen, navigation, selectedId])
  useEffect(() => {
    if (selectedId === null || selectedFilteredGoalIndex !== -1) return
    setDetailsOpen(false)
    setSelectedId(null)
    setVisibleGoalCount(initialVisibleGoalCount)
  }, [selectedFilteredGoalIndex, selectedId])

  const goalRow = (goal: WorkGoal): ReactElement => {
    const observed = observedOf(goal)
    const shown = shownOf(goal)
    const caption = rowCaption(goal, observed, externalLinks === "enabled" && window === "now" ? decisions : undefined)
    const open = requestsFor(goal).filter((request) => request.state === "open")
    const host = observed?.agent?.fact.host ?? goal.connectTarget?.host ?? goal.agentHierarchy?.agent.host
    const agentName = goal.agentHierarchy?.agent.name ?? goal.owner.name
    const pr = observed?.pullRequest?.fact
    const terminal = shown === "completed" || shown === "deployed" || shown === "abandoned"
    const stage =
      pr === undefined
        ? `Stage: ${deliveryLabel[goal.delivery]}`
        : `PR #${pr.pullRequest} ${pullRequestStateLabel[pr.state]}, ${checksLabel[pr.checks]}${pr.review === "not_requested" ? "" : ` · Review ${reviewPresentation[pr.review].label.toLowerCase()}`}`
    const metadata =
      goal.owner.name === "Unassigned"
        ? `Unassigned · ${goal.repository.repository}`
        : terminal
          ? `${agentName} · ${shown === "abandoned" ? "" : goal.delivery === "merged" || pr?.state === "merged" ? "Merged · " : "Done · "}${displayPresentation[shown].label} ${ageOf(pr?.closedAt ?? goal.updatedAt, snapshot.asOf)}`
          : `${agentName}${host === undefined ? "" : ` on ${host}`} · ${stage}${blockersFor(goal).length === 0 || open.length > 0 ? "" : ` · ${blockersFor(goal)[0]?.summary ?? "Blocked"}`}`
    const hasCaption = open.length > 0 || observed?.stale === true || observed?.unknown != null
    const content = (
      <>
        <span className="work-row-title">{goal.title}</span>
        <StateLabel
          className="work-row-state"
          icon={stateIcon[displayPresentation[shown].tone]}
          label={displayPresentation[shown].label}
          size="compact"
          tone={displayPresentation[shown].tone}
        />
        <span className="work-row-meta">
          {metadata}
          {familyLabelForGoal(snapshot, goal) === null ? null : ` · ${familyLabelForGoal(snapshot, goal)}`}
        </span>
        {hasCaption ? (
          <span className="work-row-caption" data-blocking={caption.blocking}>
            {open.length === 0 ? (
              caption.text
            ) : (
              <>
                <span className="work-request-line">
                  <StateLabel className="work-row-state" icon="clock" label="Open" size="compact" tone="caution" />{" "}
                  <span className="work-request-title">{caption.text}</span>
                </span>{" "}
                <span className="work-request-age">
                  {window === "now" ? ageOf(open[0]?.requestedAt ?? snapshot.asOf, snapshot.asOf) : "was open then"}
                </span>
              </>
            )}
          </span>
        ) : null}
      </>
    )
    const control =
      navigation === undefined ? (
        <button
          aria-controls={detailsOpen && selected?.id === goal.id ? "work-goal-details" : undefined}
          aria-expanded={detailsOpen && selected?.id === goal.id}
          aria-pressed={selected?.id === goal.id}
          className="work-board-row"
          id={selected?.id === goal.id ? selectedGoalFragment : undefined}
          onClick={() => {
            setDetailsOpen(true)
            setSelectedId(goal.id)
          }}
          ref={selected?.id === goal.id ? selectedRowRef : undefined}
          type="button"
        >
          {content}
        </button>
      ) : (
        <a
          aria-current={selected?.id === goal.id ? "true" : undefined}
          className="work-board-row"
          href={navigation({
            goalId:
              statusFilter === "all" && visibleGoalCount === initialVisibleGoalCount
                ? goal.id
                : encodeWorkBoardNavigationGoal({
                    detailsOpen: true,
                    goalId: goal.id,
                    statusFilter,
                    visibleGoalCount
                  }),
            window
          })}
          id={selected?.id === goal.id ? selectedGoalFragment : undefined}
          ref={selected?.id === goal.id ? selectedLinkRowRef : undefined}
        >
          {content}
        </a>
      )
    return control
  }

  const timeTravel = (
    <div aria-label="Choose work snapshot" className="work-time-controls" role="group">
      {windows.map((option) => {
        if (navigation === undefined) {
          return (
            <button
              aria-pressed={window === option}
              className="work-time-option"
              key={option}
              onClick={() => {
                const selectedAtOption = snapshotFor(snapshots, option).goals.find(({ id }) => id === selectedId)
                if (
                  selectedAtOption === undefined ||
                  (statusFilter !== "all" &&
                    displayStateOf(snapshotFor(snapshots, option), selectedAtOption) !== statusFilter)
                ) {
                  setDetailsOpen(false)
                }
                setVisibleGoalCount(initialVisibleGoalCount)
                setWindow(option)
              }}
              type="button"
            >
              {windowLabel[option]}
            </button>
          )
        }
        const selectedAtOption = snapshotFor(snapshots, option).goals.find(({ id }) => id === selectedId)
        const hasBoardState =
          selectedId !== null || statusFilter !== "all" || visibleGoalCount !== initialVisibleGoalCount
        return (
          <a
            aria-current={window === option ? "page" : undefined}
            className="work-time-option"
            href={navigation({
              goalId: hasBoardState
                ? encodeWorkBoardNavigationGoal({
                    detailsOpen:
                      detailsOpen &&
                      selectedAtOption !== undefined &&
                      (statusFilter === "all" ||
                        displayStateOf(snapshotFor(snapshots, option), selectedAtOption) === statusFilter),
                    goalId: selectedId,
                    statusFilter,
                    visibleGoalCount: initialVisibleGoalCount
                  })
                : null,
              window: option
            })}
            key={option}
          >
            {windowLabel[option]}
          </a>
        )
      })}
    </div>
  )

  const statusFilterControls = (
    <div aria-label="Filter goals by status" className="work-status-filters" role="group">
      {statusFilters.map((state) => {
        const label = state === "all" ? "All" : statePresentation[state].label
        return navigation === undefined ? (
          <button
            aria-pressed={statusFilter === state}
            className="work-status-filter"
            key={state}
            onFocus={({ currentTarget }) => currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
            onClick={() => {
              setDetailsOpen(false)
              setSelectedId(null)
              setStatusFilter(state)
              setVisibleGoalCount(initialVisibleGoalCount)
            }}
            type="button"
          >
            {label}
          </button>
        ) : (
          <a
            aria-current={statusFilter === state ? "page" : undefined}
            className="work-status-filter"
            onFocus={({ currentTarget }) => currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
            href={navigation({
              goalId: encodeWorkBoardNavigationGoal({
                detailsOpen: false,
                goalId: null,
                statusFilter: state,
                visibleGoalCount: initialVisibleGoalCount
              }),
              window
            })}
            key={state}
          >
            {label}
          </a>
        )
      })}
    </div>
  )

  const closeControl = (label: string): ReactElement =>
    navigation === undefined ? (
      <Button
        onClick={() => {
          setDetailsOpen(false)
          ;(selectedRowRef.current ?? selectedLinkRowRef.current)?.focus()
        }}
        className={label === "Close" ? "work-close-heading" : undefined}
        variant={label === "Close" ? "quiet" : "secondary"}
      >
        {label}
      </Button>
    ) : (
      <a
        className={`work-exact-link work-close-control${label === "Close" ? " work-close-heading" : ""}`}
        href={withFragment(
          navigation({
            goalId: encodeWorkBoardNavigationGoal({
              detailsOpen: false,
              goalId: selectedId,
              statusFilter,
              visibleGoalCount
            }),
            window
          }),
          selectedGoalFragment
        )}
      >
        {label}
      </a>
    )

  return (
    <section className="work-page" aria-labelledby="work-board-title">
      <header className="work-page-intro">
        <Text as="h1" id="work-board-title" variant="section-title">
          Work
        </Text>
        <Text tone="secondary" variant="meta">
          {headerSentences(window, snapshot, host)[0]}
        </Text>
      </header>
      {headerSentences(window, snapshot, host)
        .slice(1)
        .map((sentence) => (
          <p className="work-note work-overlay-note" data-tone="held" key={sentence}>
            <Icon decorative name="clock" size="small" />
            <span>{sentence}</span>
          </p>
        ))}
      {externalLinks === "disabled" ? (
        <p className="work-note">Read-only on the local network. Requests are decided on the hub.</p>
      ) : null}
      {window === "now" ? null : (
        <div className="work-note work-history-note">
          <span>
            Work as it was {windowLabel[window].toLowerCase()}, {formatTimestamp(snapshot.asOf)}. Decisions are off in
            the past.
          </span>
          {navigation === undefined ? (
            <Button
              onClick={() => {
                setWindow("now")
                setDetailsOpen(false)
                setSelectedId(null)
                setStatusFilter("all")
                setVisibleGoalCount(initialVisibleGoalCount)
              }}
              variant="secondary"
            >
              Back to now
            </Button>
          ) : (
            <a className="work-exact-link" href={navigation({ goalId: null, window: "now" })}>
              Back to now
            </a>
          )}
        </div>
      )}
      {snapshot.goals.length === 0 && (window === "now" || hasGoalOmissions) ? null : (
        <Hero
          caption={summaryCaption(triage.summary, tense, snapshot)}
          fact={heroFact}
          label="Work summary"
          size="heading"
        />
      )}
      <div className="work-board-controls">
        {timeTravel}
        {statusFilterControls}
      </div>
      {snapshot.goals.length === 0 ? (
        <Region
          actions={
            (snapshot.goalsOmitted ?? 0) > 0 ? (
              <Text aria-live="polite" tone="secondary" variant="meta">
                Showing 0 of {snapshot.goalsOmitted} goals
              </Text>
            ) : undefined
          }
          className="work-empty-board"
          count={snapshot.goalsOmitted ?? 0}
          title="Goals"
        >
          <div className="work-empty-copy">
            {hasGoalOmissions ? (
              <Text as="strong">No goals in this read.</Text>
            ) : window === "now" ? (
              <Text as="strong">No goals yet.</Text>
            ) : null}
            {hasGoalOmissions ? null : (
              <Text tone="secondary">
                {window === "now" ? (
                  <>
                    Delegate work to an agent with{" "}
                    <code>fleetctl submit HOST agent.delegate work REPOSITORY PROMPT</code> (HOST is a name from{" "}
                    <code>fleetctl hosts</code>); its goal appears here once the hub admits it.
                  </>
                ) : (
                  "No goals at this checkpoint."
                )}
              </Text>
            )}
            {finishedCount}
          </div>
        </Region>
      ) : (
        <div className="work-board-layout" data-has-detail={selected !== null && detailsOpen}>
          {selected === null || !detailsOpen ? null : (
            <Region
              actions={closeControl("Close")}
              aria-label="Goal details"
              className="work-inspector"
              headingId="work-goal-details-title"
              id="work-goal-details"
              ref={detailsRef}
              title="Goal details"
            >
              <GoalDetail
                closeControl={closeControl("Close details")}
                decisions={snapshot.window === "now" ? decisions : undefined}
                externalLinks={externalLinks}
                goal={selected}
                snapshot={snapshot}
              />
            </Region>
          )}
          <Region
            actions={
              filteredGoals.length === 0 ? undefined : (
                <Text aria-live="polite" tone="secondary" variant="meta">
                  Showing {visibleGoals.length} of{" "}
                  {filteredGoals.length + (statusFilter === "all" ? (snapshot.goalsOmitted ?? 0) : 0)} goals
                </Text>
              )
            }
            className="work-board-list"
            count={
              statusFilter === "all"
                ? filteredGoals.length + (snapshot.goalsOmitted ?? 0)
                : filteredGoals.length === 0
                  ? `0 of ${snapshot.goals.length + (snapshot.goalsOmitted ?? 0)}`
                  : filteredGoals.length
            }
            title="Goals"
          >
            {filteredGoals.length === 0 ? (
              <div className="work-filter-empty">
                <Text tone="secondary">No goals match this status.</Text>
                {navigation === undefined ? (
                  <Button onClick={() => setStatusFilter("all")} variant="secondary">
                    Show all
                  </Button>
                ) : (
                  <a className="work-exact-link" href={navigation({ goalId: null, window })}>
                    Show all
                  </a>
                )}
              </div>
            ) : null}
            {visibleGroups.map(({ goals, group }) => (
              <section aria-labelledby={`work-group-${group}`} className="work-group" key={group}>
                <h3 className="work-group-title" id={`work-group-${group}`}>
                  {group === "planned"
                    ? "Planned"
                    : group === "needs-you" && tense === "past"
                      ? "Needed you"
                      : workTriageGroupTitle[group]}{" "}
                  <span className="work-group-count">({goals.length})</span>
                </h3>
                <ul className="work-rows">
                  {goals.map((goal) => (
                    <li key={goal.id}>{goalRow(goal)}</li>
                  ))}
                </ul>
              </section>
            ))}
            {filteredGoals.length > 0 ? finishedCount : null}
            {visibleGoals.length < filteredGoals.length ? (
              navigation === undefined ? (
                <Button
                  onClick={() =>
                    setVisibleGoalCount((count) => Math.min(count + initialVisibleGoalCount, filteredGoals.length))
                  }
                >
                  Load 10 more
                </Button>
              ) : (
                <a
                  className="work-load-more-link"
                  href={navigation({
                    goalId: encodeWorkBoardNavigationGoal({
                      detailsOpen,
                      goalId: selectedId,
                      statusFilter,
                      visibleGoalCount: Math.min(visibleGoalCount + initialVisibleGoalCount, filteredGoals.length)
                    }),
                    window
                  })}
                >
                  Load 10 more
                </a>
              )
            ) : null}
          </Region>
        </div>
      )}
    </section>
  )
}
