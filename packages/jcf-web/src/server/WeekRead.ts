/** Read one week with progress owned by the request. Disconnecting cancels its work. */
import type { ConfigService, IssueFacts, ReconcileService } from "@knpkv/jira-clockify"
import { Time } from "@knpkv/jira-clockify"
import { Clock, Effect, Queue, Stream } from "effect"
import {
  ApiError,
  PlanExpiredError,
  type ReadProgress,
  type WeekPlanResponse,
  type WeekReadEvent,
  type WeekScopeName
} from "../shared/contracts.js"
import { retainedEntryRevision } from "./SavedEntryOperations.js"
import { buildWeekPlan, sidesOfScope } from "./WeekPlan.js"
import type { WeekPlansContract } from "./WeekPlans.js"

/** Translate events for the authenticated owner; request text contains supplied session evidence. */
export const sessionProgress = (event: ReconcileService.SessionProposalProgress): ReadProgress => {
  switch (event._tag) {
    case "AgentActivity":
      return {
        stage: "attribution",
        message: `Agent batch ${event.batch} of ${event.batches}`,
        activity: { batch: event.batch, batches: event.batches, kind: event.kind, text: event.text }
      }
    case "SessionsRead":
      return {
        stage: "attribution",
        message: `${event.count} sessions read. Matching branches and directory mappings.`
      }
    case "AttributingSessions":
      return {
        stage: "attribution",
        message: `Asking the coding agent about ${event.count} sessions in ${event.calls} batches.`,
        completed: 0,
        total: event.count
      }
    case "SessionAttributed":
      return {
        stage: "attribution",
        message: `${event.done} of ${event.total} sessions checked. ${
          event.outcome._tag === "Placed"
            ? `Matched ${event.outcome.ticketKey}.`
            : event.outcome._tag === "Declined"
            ? "No confident ticket match."
            : "Agent unavailable for this session; its hours will remain visible."
        }`,
        completed: event.done,
        total: event.total
      }
    case "SessionsAttributed":
      return {
        stage: "attribution",
        message:
          `${event.placed} matched, ${event.declined} unmatched, ${event.unavailable} unavailable. Calculating credited time.`
      }
    case "ReadingRecordedTime":
      return {
        stage: "recorded",
        message: `Reading ${
          event.sides.clockify && event.sides.jira
            ? "Clockify entries and Jira worklogs"
            : event.sides.clockify
            ? "Clockify entries"
            : "Jira worklogs"
        }${event.sides.clockify ? " and checking running timers" : ""}.`
      }
  }
}

/** Return retained evidence without touching sessions or providers. A miss never starts attribution. */
export const savedWeekPlan = Effect.fn("WeekRead.saved")(function*(options: {
  readonly query: { readonly monday?: string | undefined; readonly only?: WeekScopeName | undefined }
  readonly plans: WeekPlansContract
}) {
  const anchor = options.query.monday === undefined
    ? new Date(yield* Clock.currentTimeMillis)
    : new Date(`${options.query.monday}T00:00:00`)
  const monday = Time.localDay(Time.isoWeekPeriod(anchor).from)
  const scope = options.query.only ?? "both"
  const held = yield* options.plans.forWeek(monday, scope)
  return { monday, scope, plan: held?.plan ?? null }
})

/** Shared by the JSON and streaming routes so both retain identical held evidence. */
export const readWeekPlan = Effect.fn("WeekRead.read")(function*(options: {
  readonly query: { readonly monday?: string | undefined; readonly only?: WeekScopeName | undefined }
  readonly report: (progress: ReadProgress) => Effect.Effect<void>
  readonly reconcile: ReconcileService.ReconcileServiceContract
  readonly issues: IssueFacts.IssueFacts["Service"]
  readonly config: ConfigService.ConfigService["Service"]
  readonly plans: WeekPlansContract
}) {
  const { config, issues, plans, query, reconcile, report } = options
  const generation = yield* plans.readGeneration
  const anchor = query.monday === undefined
    ? new Date(yield* Clock.currentTimeMillis)
    : new Date(`${query.monday}T00:00:00`)
  const period = Time.isoWeekPeriod(anchor)
  const scope = query.only ?? "both"
  const sides = sidesOfScope(scope)
  yield* report({ stage: "sessions", message: "Reading coding sessions from your configured directories." })
  const result = yield* reconcile.proposeFromSessions(period, {
    sides,
    onProgress: (event) => report(sessionProgress(event))
  }).pipe(
    Effect.mapError((error) => new ApiError({ message: error.message }))
  )
  const settings = yield* config.get
  const keys = [...new Set([...result.proposals, ...result.recorded, ...result.withheld].map((row) => row.ticketKey))]
  yield* report({
    stage: "issues",
    message: sides.jira
      ? `Looking up titles and assignees for ${keys.length} Jira tickets.`
      : "Skipping Jira titles and ownership in Clockify-only mode."
  })
  const looked = sides.jira ? yield* issues.lookup(keys) : { checked: false, facts: new Map() }
  yield* report({ stage: "calendar", message: "Placing logged time and proposed blocks on the calendar." })
  const held = buildWeekPlan({
    createdAtMillis: yield* Clock.currentTimeMillis,
    monday: period.from,
    ownership: {
      checked: looked.checked,
      facts: looked.facts,
      mode: settings.sessionOwnership,
      overrides: settings.sessionOwnershipOverrides
    },
    planId: yield* plans.nextPlanId.pipe(
      Effect.mapError(() => new ApiError({ message: "Could not create a week plan. Retry the read." }))
    ),
    report: result,
    scope
  })
  return (yield* plans.keep(held, generation)).plan
})

/** Read logged time without session discovery, attribution, or ownership lookups. */
export const readRecordedWeekPlan = Effect.fn("WeekRead.recordedOnly")(function*(options: {
  readonly query: { readonly monday?: string | undefined; readonly only?: WeekScopeName | undefined }
  readonly report: (progress: ReadProgress) => Effect.Effect<void>
  readonly reconcile: ReconcileService.ReconcileServiceContract
  readonly config: ConfigService.ConfigService["Service"]
  readonly plans: WeekPlansContract
}) {
  const { config, plans, query, reconcile, report } = options
  const generation = yield* plans.readGeneration
  const anchor = query.monday === undefined
    ? new Date(yield* Clock.currentTimeMillis)
    : new Date(`${query.monday}T00:00:00`)
  const period = Time.isoWeekPeriod(anchor)
  const scope = query.only ?? "both"
  const previous = yield* plans.forWeek(Time.localDay(period.from), scope)
  if (previous !== undefined) {
    return yield* refreshWeekPlan({ planId: previous.planId, report, reconcile, plans })
  }
  const sides = sidesOfScope(scope)
  yield* report(sessionProgress({ _tag: "ReadingRecordedTime", sides }))
  const settings = yield* config.get
  const result = yield* reconcile.refreshRecordedTime(period, {
    attributed: [],
    proposals: [],
    recorded: [],
    unlinkedClockify: [],
    sides,
    withheld: [],
    unattributed: [],
    excludedDays: [],
    attributorAvailable: true,
    sessionCount: 0,
    sessionRootCount: settings.sessionRoots.length,
    attributorCalls: 0,
    digests: new Map()
  }).pipe(Effect.mapError((error) => new ApiError({ message: error.message })))
  yield* report({ stage: "calendar", message: "Placing logged time on the calendar. Sessions have not been scanned." })
  const held = buildWeekPlan({
    createdAtMillis: yield* Clock.currentTimeMillis,
    monday: period.from,
    planId: yield* plans.nextPlanId.pipe(
      Effect.mapError(() => new ApiError({ message: "Could not create a week plan. Retry the read." }))
    ),
    report: result,
    scope,
    sessionScanAvailable: false
  })
  return (yield* plans.keep(held, generation)).plan
})

/** Refresh provider facts against the retained week; no session reader or attributor is called. */
export const refreshWeekPlan = Effect.fn("WeekRead.refreshRecorded")(function*(options: {
  readonly planId: string
  readonly report: (progress: ReadProgress) => Effect.Effect<void>
  readonly reconcile: ReconcileService.ReconcileServiceContract
  readonly plans: WeekPlansContract
}) {
  const { plans, reconcile, report } = options
  const generation = yield* plans.readGeneration
  const previous = yield* plans.find(options.planId)
  if (previous === undefined) {
    return yield* new PlanExpiredError({
      message: "This week is no longer held. Use Rescan sessions to read its sessions again."
    })
  }
  const period = Time.isoWeekPeriod(new Date(`${previous.plan.monday}T00:00:00`))
  const status = sessionProgress({ _tag: "ReadingRecordedTime", sides: previous.report.sides })
  const scanned = previous.plan.sessionScanAvailable !== false
  yield* report({ ...status, message: scanned ? `${status.message} Keeping your session matches.` : status.message })
  const refreshed = yield* reconcile.refreshRecordedTime(period, previous.report, {
    jiraIssueKeys: [...previous.jiraReceiptIssueKeys]
  }).pipe(
    Effect.mapError((error) => new ApiError({ message: error.message }))
  )
  yield* report({
    stage: "calendar",
    message: scanned
      ? "Updating logged time and remaining proposals. Session matches are unchanged."
      : "Updating logged time. Sessions have not been scanned."
  })
  const snapshotRevision = yield* plans.nextPlanId.pipe(
    Effect.mapError(() => new ApiError({ message: "Could not create an entry revision. Retry the refresh." }))
  )
  const held = buildWeekPlan({
    planId: previous.planId,
    entryRevision: (entry) => retainedEntryRevision(previous, entry, snapshotRevision),
    createdAtMillis: previous.createdAtMillis,
    monday: period.from,
    report: refreshed,
    consumption: previous.consumption,
    jiraReceiptIssueKeys: previous.jiraReceiptIssueKeys,
    scope: previous.plan.scope,
    ownership: previous.ownership,
    sessionScanAvailable: previous.plan.sessionScanAvailable
  })
  return (yield* plans.replace(previous, held, generation)).plan
})

/** Bounded NDJSON transport; typed read failures are terminal events after headers have been sent. */
export const streamWeekRead = (
  read: (
    report: (progress: ReadProgress) => Effect.Effect<void>
  ) => Effect.Effect<WeekPlanResponse, ApiError | PlanExpiredError>
) =>
  Stream.callback<WeekReadEvent>(
    (queue) =>
      read((progress) => Queue.offer(queue, { _tag: "Progress", progress }).pipe(Effect.asVoid)).pipe(
        Effect.flatMap((plan) => Queue.offer(queue, { _tag: "Complete", plan })),
        Effect.catchTags({
          ApiError: (error) => Queue.offer(queue, { _tag: "Failed", message: error.message }),
          PlanExpiredError: (error) => Queue.offer(queue, { _tag: "Failed", message: error.message })
        }),
        Effect.andThen(Queue.end(queue))
      ),
    { bufferSize: 16, strategy: "suspend" }
  ).pipe(Stream.map((event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`)))
