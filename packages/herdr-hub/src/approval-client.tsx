import { dashboardRefreshView } from "./internal/dashboard-refresh.js"
import { RegistryProvider, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { BrowserCrypto, BrowserHttpClient } from "@effect/platform-browser"
import { makeRelayClient, makeRelayConversations } from "@knpkv/relay-product/client"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { makeConnectModuleViews } from "./connect-module-view.js"
import { loadLimits, loadUsage, makeUsageAtoms, onLoopback, UsageSurface } from "@knpkv/herdr-connect/usage"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Result, Schema } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import * as Atom from "effect/reactivity/Atom"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { decodeWorkNavigationSelection, workNavigationHref } from "@knpkv/herdr-work/navigation"
import { WorkBoard } from "@knpkv/herdr-work/react"
import { PushPublicConfiguration, PushSubscriptionRecord, PushSubscriptionStatus } from "./model.js"
import {
  applicationServerKey,
  reconcileCurrentPushSubscription,
  reconcilePushSubscriptionState,
  registerNewPushSubscription,
  unregisterPushSubscription
} from "./push-subscription.js"
import { NotificationPanel, type NotificationState } from "./approval-app-view.js"
import { ActivityHistory } from "./activity-history.js"
import {
  DashboardSnapshot,
  type DashboardSnapshot as DashboardSnapshotType,
  DashboardHistoryPage,
  FleetPendingApprovals,
  PendingApprovalTarget
} from "./dashboard-model.js"
import { DashboardView, type ApprovalDecision } from "./dashboard-view.js"
import { type HubRelayConversation, watchRelayPage } from "./hub-relay.js"
import {
  dashboardHistoryState,
  dashboardPendingBadgeCount,
  dashboardPendingNavigationBadge,
  loadDashboardPendingPage,
  mergeDashboardHistoryPage,
  withPendingApprovalTarget
} from "./internal/dashboard-pending-state.js"
import { FleetWorkPanel, fleetWorkRequestStateFromResult, fleetWorkStateFromRequest } from "./shell-view.js"
import { readApprovalDeepLink } from "./pwa.js"
import { useApprovalTargetFocus } from "./internal/approval-target-focus.js"
import { SanitizedJobRecord } from "./approval-request.js"
import { answerForStatus, answerSettles, answerText, DecisionAnswer } from "./countdown-model.js"
import type { DecisionStatus } from "./countdown-view.js"
import { useHubNow } from "./hub-clock.js"
import { answerOutcome, decidableExpiry, workRequestDecisionsFor } from "./work-decisions.js"
import { DashboardWorkPollOwner } from "./work-poll-owner.js"
import { SuperappShell } from "./superapp-view.js"
import { superappLayout } from "./internal/superapp-layout.js"
import { makeFleetHubModuleViews } from "./fleet-module-view.js"
import { TodayReadFailed } from "./today-module-view.js"
import { makeResourcesModuleViews } from "./resources-module-view.js"
import { loadHostResources } from "./resources-client.js"
import { makeUsageModuleViews, type UsageModuleReads } from "./usage-module-view.js"
import { makeCodeModuleViews } from "./code-module-view.js"
import { loadStack, loadStackPlan, loadStacksOverview, type StacksModuleReads } from "./stacks-client.js"
import { makeStacksModuleViews } from "./stacks-module-view.js"
import { loadSandboxesCaller, loadSandboxesOverview, submitSandboxJob } from "./sandboxes-client.js"
import {
  makeSandboxesModuleViews,
  type SandboxesModuleReads,
  type SandboxesModuleWrites
} from "./sandboxes-module-view.js"
import {
  loadCodeQueue,
  loadCodeDetail,
  loadCodeDiff,
  loadCodeCanvas,
  loadCodeCommit,
  loadCodeContent,
  loadCodeReview,
  type CodeModuleReads
} from "./code-client.js"
import { NeedsYouResult } from "./modules.js"
import { RefreshStatus } from "./refresh-status.js"
import { dashboardPolls } from "./internal/dashboard-polls.js"
import { useDashboardPending } from "./internal/use-dashboard-pending.js"
import { useDashboardPendingTarget } from "./internal/use-dashboard-pending-target.js"
import type { PendingApprovalTargetRevalidation } from "./internal/dashboard-pending-state.js"
import type { ApprovalNotificationCandidate } from "./model.js"

class BrowserNetworkError extends Schema.TaggedError<BrowserNetworkError>()("BrowserNetworkError", {
  detail: Schema.String
}) {}

class BrowserStatusError extends Schema.TaggedError<BrowserStatusError>()("BrowserStatusError", {
  status: Schema.Number
}) {}

class BrowserJsonError extends Schema.TaggedError<BrowserJsonError>()("BrowserJsonError", { detail: Schema.String }) {}

class DashboardBootstrapError extends Schema.TaggedError<DashboardBootstrapError>()("DashboardBootstrapError", {
  cause: Schema.Defect(),
  detail: Schema.String
}) {}

class PushBrowserError extends Schema.TaggedError<PushBrowserError>()("PushBrowserError", {
  reason: Schema.Literals(["unsupported", "disabled", "permission_denied", "subscription_missing"])
}) {}

type PullState = {
  readonly distance: number
  readonly ready: boolean
  readonly refreshing: boolean
}

type BrowserRequest = { readonly method?: "GET" } | { readonly body?: string; readonly method: "DELETE" | "POST" }

const initialPull: PullState = {
  distance: 0,
  ready: false,
  refreshing: false
}

const fetchJson = Effect.fn("ApprovalClient.fetchJson")(function* <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  url: string,
  init?: BrowserRequest
) {
  const client = yield* HttpClient.HttpClient
  const baseRequest = HttpClientRequest.make(init?.method ?? "GET")(url)
  const request =
    init !== undefined && "body" in init && init.body !== undefined
      ? baseRequest.pipe(HttpClientRequest.bodyText(init.body, "application/json"))
      : baseRequest
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => new BrowserNetworkError({ detail: String(cause) })))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BrowserStatusError({ status: response.status })
  }
  return yield* decodeBoundedResponseJson(response, schema).pipe(
    Effect.mapError((cause) => new BrowserJsonError({ detail: String(cause) }))
  )
})

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)

const loadDashboard = fetchJson(DashboardSnapshot, "/v1/dashboard")
const loadToday = fetchJson(NeedsYouResult, "/v1/modules/connect/needs-you").pipe(
  Effect.timeout("6 seconds"),
  Effect.mapError((failure) => {
    const reasons = {
      BrowserNetworkError: "network",
      BrowserStatusError: "status",
      BrowserJsonError: "invalid_json",
      TimeoutError: "timeout"
    } satisfies Record<typeof failure._tag, TodayReadFailed["reason"]>
    return new TodayReadFailed({ reason: reasons[failure._tag] })
  })
)

const loadDashboardPending = Effect.fn("Dashboard.loadPending")((
  continuation: DashboardSnapshotType["pendingApprovals"]["nextCursors"][number]
) => {
  const parameters = new URLSearchParams({
    cursorCreatedAt: String(continuation.cursor.createdAt),
    cursorHost: continuation.host,
    cursorId: continuation.cursor.id
  })
  return fetchJson(FleetPendingApprovals, `/v1/dashboard-pending?${parameters.toString()}`)
})

const loadDashboardHistory = Effect.fn("Dashboard.loadHistory")((
  cursor: NonNullable<DashboardSnapshotType["historyNextCursor"]>
) => {
  const parameters = new URLSearchParams({
    cursorCreatedAt: String(cursor.createdAt),
    cursorId: cursor.id
  })
  return fetchJson(DashboardHistoryPage, `/v1/dashboard-history?${parameters.toString()}`)
})

const loadPendingApprovalTarget = Effect.fn("Dashboard.loadPendingApprovalTarget")((target: {
  readonly host: string
  readonly jobId: string
}) => {
  const parameters = new URLSearchParams(target)
  return fetchJson(PendingApprovalTarget, `/v1/pending-approval?${parameters.toString()}`)
})

const decide = Effect.fn("Dashboard.decide")(function* (decision: ApprovalDecision) {
  return yield* fetchJson(SanitizedJobRecord, `/v1/jobs/${encodeURIComponent(decision.jobId)}/${decision.decision}`, {
    method: "POST"
  })
})

/**
 * The hub's answer to one decision: the record it returned, a status, or no answer. A lost
 * connection or an unreadable success body leaves the outcome open.
 */
const decisionAnswerOf = (
  decision: ApprovalDecision,
  exit: Exit.Exit<SanitizedJobRecord, BrowserNetworkError | BrowserStatusError | BrowserJsonError>
): DecisionAnswer => {
  if (Exit.isSuccess(exit)) return DecisionAnswer.Accepted({ decision: decision.decision, record: exit.value })
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) return DecisionAnswer.Uncertain({ status: null })
  switch (failure.value._tag) {
    case "BrowserStatusError":
      return answerForStatus(failure.value.status)
    case "BrowserJsonError":
      return DecisionAnswer.Unreadable()
    case "BrowserNetworkError":
      return DecisionAnswer.Uncertain({ status: null })
  }
}

const pushSupported = (): boolean =>
  window.isSecureContext && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator

const loadPushConfiguration = fetchJson(PushPublicConfiguration, "/v1/push/config")

const registerPushSubscription = Effect.fn("Notifications.register")(function* (subscription: PushSubscription) {
  const decoded = yield* Schema.decodeUnknownEffect(PushSubscriptionRecord)(subscription.toJSON())
  yield* fetchJson(PushSubscriptionStatus, "/v1/push/subscriptions", {
    body: JSON.stringify(decoded),
    method: "POST"
  })
})

const isPushSubscriptionRegistered = Effect.fn("Notifications.status")(function* (subscription: PushSubscription) {
  const status = yield* fetchJson(
    PushSubscriptionStatus,
    `/v1/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`
  )
  return status.subscribed
})

const removePushSubscriptionRegistration = Effect.fn("Notifications.remove")(function* (
  subscription: PushSubscription
) {
  yield* fetchJson(PushSubscriptionStatus, "/v1/push/subscriptions", {
    body: JSON.stringify({ endpoint: subscription.endpoint }),
    method: "DELETE"
  })
})

const loadNotificationState = Effect.gen(function* () {
  const config = yield* loadPushConfiguration
  if (!config.enabled || config.publicKey === null) return "disabled"
  if (!pushSupported()) return "unsupported"
  if (Notification.permission === "denied") {
    return yield* reconcilePushSubscriptionState(
      Notification.permission,
      null,
      isPushSubscriptionRegistered,
      registerPushSubscription
    )
  }
  const registration = yield* Effect.tryPromise({
    try: () => navigator.serviceWorker.getRegistration("/"),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  const subscription =
    registration === undefined
      ? null
      : yield* Effect.tryPromise({
          try: () => registration.pushManager.getSubscription(),
          catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
        })
  if (subscription !== null && registration !== undefined) {
    const expectedKey = applicationServerKey(config.publicKey)
    return yield* reconcileCurrentPushSubscription(
      subscription,
      expectedKey,
      Effect.tryPromise({
        try: () =>
          registration.pushManager.subscribe({
            applicationServerKey: expectedKey,
            userVisibleOnly: true
          }),
        catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
      }),
      isPushSubscriptionRegistered,
      registerPushSubscription,
      removePushSubscriptionRegistration
    ).pipe(Effect.map((): NotificationState => "enabled"))
  }
  return yield* reconcilePushSubscriptionState(
    Notification.permission,
    subscription,
    isPushSubscriptionRegistered,
    registerPushSubscription
  )
}).pipe(Effect.map((state): NotificationState => state))

type NotificationLoadError =
  typeof loadNotificationState extends Effect.Effect<unknown, infer Error, unknown> ? Error : never

const enableNotifications = Effect.fn("Notifications.enable")(function* () {
  const config = yield* loadPushConfiguration
  if (!config.enabled || config.publicKey === null) {
    return yield* new PushBrowserError({ reason: "disabled" })
  }
  const publicKey = config.publicKey
  if (!pushSupported()) {
    return yield* new PushBrowserError({ reason: "unsupported" })
  }
  const permission = yield* Effect.tryPromise({
    try: () => Notification.requestPermission(),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  if (permission !== "granted") {
    return yield* new PushBrowserError({ reason: "permission_denied" })
  }
  const registration = yield* Effect.tryPromise({
    try: () =>
      navigator.serviceWorker.register("/assets/approval-sw.js", {
        scope: "/",
        updateViaCache: "none"
      }),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  const existing = yield* Effect.tryPromise({
    try: () => registration.pushManager.getSubscription(),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  const expectedKey = applicationServerKey(publicKey)
  const acquire = Effect.tryPromise({
    try: () =>
      registration.pushManager.subscribe({
        applicationServerKey: expectedKey,
        userVisibleOnly: true
      }),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  if (existing !== null) {
    yield* reconcileCurrentPushSubscription(
      existing,
      expectedKey,
      acquire,
      isPushSubscriptionRegistered,
      registerPushSubscription,
      removePushSubscriptionRegistration
    )
    return
  }
  return yield* registerNewPushSubscription(acquire, registerPushSubscription)
})

const disableNotifications = Effect.fn("Notifications.disable")(function* () {
  if (!pushSupported()) {
    return yield* new PushBrowserError({ reason: "unsupported" })
  }
  const registration = yield* Effect.tryPromise({
    try: () => navigator.serviceWorker.getRegistration("/"),
    catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
  })
  const subscription =
    registration === undefined
      ? null
      : yield* Effect.tryPromise({
          try: () => registration.pushManager.getSubscription(),
          catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
        })
  if (subscription === null) {
    return yield* new PushBrowserError({ reason: "subscription_missing" })
  }
  yield* unregisterPushSubscription(
    Effect.tryPromise({
      try: () => subscription.unsubscribe(),
      catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
    }),
    fetchJson(PushSubscriptionStatus, "/v1/push/subscriptions", {
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      method: "DELETE"
    })
  )
  if ("clearAppBadge" in navigator) {
    yield* Effect.tryPromise({
      try: () => navigator.clearAppBadge(),
      catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
    })
  }
})

const setApprovalBadge = Effect.fn("Notifications.setBadge")((count: number) =>
  "setAppBadge" in navigator
    ? Effect.tryPromise({
        try: () => navigator.setAppBadge(count),
        catch: (cause) => new BrowserNetworkError({ detail: String(cause) })
      })
    : Effect.void
)

const makeDashboardAtoms = (initial: DashboardSnapshotType) => {
  // Only what this listener serves is ever requested; a host dashboard has no push or (when it is
  // cross-host) Work snapshot, and polling them only produced 404s.
  const served = dashboardPolls(initial.approvalApp)
  const connect = makeConnectAtoms()
  const work = served.work ? connect.work : browserRuntime.atom(Effect.never)
  const workPoll = served.work ? connect.workPoll : browserRuntime.atom(Effect.never)
  return {
    badge: browserRuntime.fn(setApprovalBadge),
    busyJob: Atom.make<string | null>(null),
    connect,
    usage: makeUsageAtoms(),
    // The served snapshot: what the page shows until a refresh succeeds, and after one fails.
    bootstrap: initial,
    dashboard: browserRuntime.atom(loadDashboard, { initialValue: initial }),
    decision: browserRuntime.fn(decide),
    notification: browserRuntime.atom<NotificationState, NotificationLoadError>(
      served.push ? loadNotificationState : Effect.succeed<NotificationState>("unsupported"),
      {
        initialValue: "loading"
      }
    ),
    notificationAction: browserRuntime.fn((enable: boolean) =>
      enable ? enableNotifications() : disableNotifications()
    ),
    historyPage: browserRuntime.fn(loadDashboardHistory),
    pendingPage: browserRuntime.fn(loadDashboardPending),
    pendingTarget: browserRuntime.fn(loadPendingApprovalTarget),
    pull: Atom.make<PullState>(initialPull),
    work,
    workPoll
  }
}

type DashboardAtoms = ReturnType<typeof makeDashboardAtoms>

const DashboardApp = ({
  atoms,
  codeReads,
  readToday,
  usageReads
}: {
  readonly atoms: DashboardAtoms
  readonly readToday: Effect.Effect<typeof NeedsYouResult.Type, TodayReadFailed>
  readonly usageReads: UsageModuleReads
  readonly codeReads: CodeModuleReads
}) => {
  const result = useAtomValue(atoms.dashboard)
  const { refreshFailed, snapshot } = dashboardRefreshView(result, atoms.bootstrap)
  const workResult = useAtomValue(atoms.work)
  const notificationResult = useAtomValue(atoms.notification)
  const refresh = useAtomRefresh(atoms.dashboard)
  const refreshWork = useAtomRefresh(atoms.work)
  const refreshNotification = useAtomRefresh(atoms.notification)
  const runDecision = useAtomSet(atoms.decision, { mode: "promiseExit" })
  const runBadge = useAtomSet(atoms.badge, { mode: "promiseExit" })
  const runNotificationAction = useAtomSet(atoms.notificationAction, {
    mode: "promiseExit"
  })
  const runPendingTarget = useAtomSet(atoms.pendingTarget, {
    mode: "promiseExit"
  })
  const runHistoryPage = useAtomSet(atoms.historyPage, {
    mode: "promiseExit"
  })
  const runPendingPage = useAtomSet(atoms.pendingPage, {
    mode: "promiseExit"
  })
  const [busyJobId, setBusyJobId] = useAtom(atoms.busyJob)
  const [sendingDecision, setSendingDecision] = useState<ApprovalDecision | null>(null)
  const [decisionStatus, setDecisionStatus] = useState<DecisionStatus | null>(null)
  const [pull, setPull] = useAtom(atoms.pull)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyState, setHistoryState] = useState(dashboardHistoryState(0, [], initial.historyNextCursor))
  const [pendingBusy, setPendingBusy] = useState(false)
  const [routeSearch, setRouteSearch] = useState(window.location.search)
  const { state: pendingState, update: setPendingState } = useDashboardPending(snapshot)
  const loadTarget = useCallback(
    async (link: ApprovalNotificationCandidate): Promise<PendingApprovalTargetRevalidation> => {
      const exit = await runPendingTarget(link)
      if (Exit.isSuccess(exit)) return { _tag: "Found", target: exit.value }
      const failure = Cause.findErrorOption(exit.cause)
      const missing =
        Option.isSome(failure) && failure.value._tag === "BrowserStatusError" && failure.value.status === 404
      if (!missing) Effect.runFork(Effect.logWarning(Cause.pretty(exit.cause)))
      return { _tag: missing ? "Missing" : "Retry" }
    },
    [runPendingTarget]
  )
  const decodedDeepLink = readApprovalDeepLink(routeSearch)
  const { check: pendingTargetCheck, target: deepLinkTarget } = useDashboardPendingTarget(
    snapshot,
    Result.isSuccess(decodedDeepLink) ? decodedDeepLink.success : null,
    loadTarget
  )
  const start = useRef<number | null>(null)

  const resetPull = (): void => {
    start.current = null
    setPull(initialPull)
  }
  const refreshDashboard = (): void => {
    setPull({ ...initialPull, refreshing: true })
    refresh()
    refreshWork()
  }
  const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    if (window.scrollY === 0 && event.touches.length === 1) {
      start.current = event.touches[0]?.clientY ?? null
    }
  }
  const onTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
    if (start.current === null) return
    const current = event.touches[0]?.clientY
    if (current === undefined) return
    const delta = current - start.current
    if (delta <= 0) {
      resetPull()
      return
    }
    if (event.cancelable) event.preventDefault()
    const distance = Math.min(88, delta * 0.48)
    setPull({ distance, ready: distance >= 64, refreshing: false })
  }
  const onTouchEnd = (): void => {
    if (start.current === null) return
    start.current = null
    if (pull.ready) {
      refreshDashboard()
      return
    }
    resetPull()
  }
  // The latest rendered snapshot's time, read when a decision's answer arrives (the render that
  // created onDecision may be older by then).
  const latestObservedAt = useRef(0)
  const onDecision = async (decision: ApprovalDecision): Promise<void> => {
    // The decided request's expiry, read from the snapshot it was decided on.
    const expiresAt = decidableExpiry(currentSnapshot, decision.jobId)
    setBusyJobId(decision.jobId)
    setSendingDecision(decision)
    setDecisionStatus(null)
    const exit = await runDecision(decision)
    setBusyJobId(null)
    setSendingDecision(null)
    const answer = decisionAnswerOf(decision, exit)
    setDecisionStatus({
      expiresAt,
      jobId: decision.jobId,
      // The snapshot on screen now, when the answer arrived; only a later read may unlock the request.
      observedAt: latestObservedAt.current,
      outcome: answerOutcome(answer),
      settles: answerSettles(answer),
      text: answerText(answer)
    })
    // Whatever the answer, the queue is re-read so the page shows the hub's own state next.
    refreshDashboard()
  }
  const onNotificationAction = async (enable: boolean): Promise<void> => {
    await runNotificationAction(enable)
    refreshNotification()
  }
  const onLoadHistory = async (): Promise<void> => {
    if (historyState.nextCursor === null || historyBusy) return
    const request = {
      cursor: historyState.nextCursor,
      generation: historyState.generation
    }
    setHistoryBusy(true)
    const exit = await runHistoryPage(request.cursor)
    setHistoryBusy(false)
    if (Exit.isFailure(exit)) {
      Effect.runFork(Effect.logWarning(Cause.pretty(exit.cause)))
      return
    }
    setHistoryState((state) => mergeDashboardHistoryPage(state, request, exit.value))
  }
  const onLoadPending = async (): Promise<void> => {
    if (pendingBusy) return
    setPendingBusy(true)
    const result = await loadDashboardPendingPage(pendingState, runPendingPage, setPendingState)
    setPendingBusy(false)
    if (result._tag === "Failure") {
      Effect.runFork(Effect.logWarning(Cause.pretty(result.cause)))
    }
  }

  // The page keeps working on the last snapshot; the cause goes to the log, not the screen.
  useEffect(() => {
    if (result._tag === "Failure")
      Effect.runFork(Effect.logWarning("dashboard refresh failed", Cause.pretty(result.cause)))
  }, [result])
  const work = AsyncResult.isSuccess(workResult)
    ? workResult.value
    : workResult._tag === "Failure" && workResult.previousSuccess._tag === "Some"
      ? workResult.previousSuccess.value.value
      : snapshot.work
  const notificationState: NotificationState = AsyncResult.isSuccess(notificationResult)
    ? notificationResult.value
    : notificationResult._tag === "Failure"
      ? "error"
      : "loading"
  const waiting = AsyncResult.isWaiting(result)
  const canonical = snapshot.approvalApp.canonical === true
  const superapp = snapshot.approvalApp.superapp
  const currentSnapshot = withPendingApprovalTarget(
    {
      ...(work === undefined ? snapshot : { ...snapshot, work }),
      historyNextCursor: historyState.nextCursor,
      pendingApprovals: pendingState,
      records: [...snapshot.records, ...historyState.records]
    },
    deepLinkTarget
  )
  useEffect(() => {
    if (!waiting && pull.refreshing) {
      setPull(initialPull)
    }
  }, [pull.refreshing, setPull, waiting])
  useEffect(() => {
    setHistoryState((state) => dashboardHistoryState(state.generation + 1, [], snapshot.historyNextCursor))
  }, [snapshot])
  useEffect(() => {
    const decoded = readApprovalDeepLink(routeSearch)
    if (Result.isFailure(decoded)) {
      Effect.runFork(Effect.logWarning(decoded.failure))
      return
    }
  }, [snapshot, routeSearch])
  useApprovalTargetFocus(routeSearch, currentSnapshot.observedAt, deepLinkTarget)
  useEffect(() => {
    latestObservedAt.current = currentSnapshot.observedAt
  }, [currentSnapshot.observedAt])
  // The Work board's request clocks read hub time, like the Approvals countdown.
  const workNow = useHubNow(currentSnapshot.observedAt, [
    ...currentSnapshot.pendingApprovals.local.map((record) => record.approvalExpiresAt ?? null),
    ...currentSnapshot.pendingApprovals.remote.map(({ approval }) => approval.approvalExpiresAt)
  ])
  const pendingBadgeCount = dashboardPendingBadgeCount(pendingState, workNow)
  useEffect(() => {
    if (!canonical || pendingBadgeCount === null || !pushSupported()) return
    void runBadge(pendingBadgeCount).then((exit) => {
      if (Exit.isFailure(exit)) {
        Effect.runFork(Effect.logError(Cause.pretty(exit.cause)))
      }
    })
  }, [canonical, pendingBadgeCount, runBadge])
  const current = currentSnapshot
  const workSelection = decodeWorkNavigationSelection(routeSearch)
  const workContent =
    current.work === null ? null : (
      <WorkBoard
        host={current.host}
        {...(workSelection.goalId === null ? {} : { initialGoalId: workSelection.goalId })}
        decisions={workRequestDecisionsFor({
          now: workNow,
          onDecision: (decision) => void onDecision(decision),
          sending: sendingDecision,
          snapshot: current,
          status: decisionStatus
        })}
        initialWindow={workSelection.window}
        navigation={workNavigationHref}
        snapshots={current.work}
      />
    )
  const workRequestState = fleetWorkRequestStateFromResult({ content: workContent, result: workResult })
  const workState = fleetWorkStateFromRequest(workRequestState)
  // A failed refresh keeps the page; this says so in the page gutter, under the masthead.
  const refreshNotice = <RefreshStatus failed={refreshFailed} observedAt={current.observedAt} onRetry={refresh} />
  const dashboardView = (
    <DashboardView
      approvalOnly={superapp}
      refreshFailed={refreshFailed}
      pendingTargetCheck={pendingTargetCheck}
      busyJobId={busyJobId}
      decisionStatus={decisionStatus}
      sendingDecision={sendingDecision}
      historyLoading={historyBusy}
      pendingLoading={pendingBusy}
      notificationState={notificationState}
      onDecision={(decision) => void onDecision(decision)}
      onDisableNotifications={() => void onNotificationAction(false)}
      onEnableNotifications={() => void onNotificationAction(true)}
      onLoadHistory={() => void onLoadHistory()}
      onLoadPending={() => void onLoadPending()}
      onRefresh={refreshDashboard}
      pull={pull}
      showHeader={!superapp}
      notice={superapp ? null : refreshNotice}
      snapshot={current}
    />
  )
  const hostCount = current.directory === null ? 1 : current.directory.links.length + 1
  const gesture = { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: resetPull }
  const fleet = makeFleetHubModuleViews({
    approvals: dashboardView,
    connect: null,
    hostCount,
    notice: refreshNotice,
    usage: <UsageSurface atoms={atoms.usage} />,
    gesture,
    work: (
      <section className="fleet-workspace">
        <FleetWorkPanel state={workState} />
        <ActivityHistory
          hasMore={current.historyNextCursor !== null}
          loading={historyBusy}
          onLoadMore={() => void onLoadHistory()}
          records={current.records}
        />
      </section>
    )
  })
  const connect = makeConnectModuleViews({
    atoms: atoms.connect,
    readApprovals: readToday,
    now: workNow,
    notificationState,
    fleet: snapshot.approvalApp.fleet,
    push: snapshot.approvalApp.pushEnabled
  })
  const usage = makeUsageModuleViews({
    reads: usageReads,
    viewerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Received report timestamps use the browser clock, unlike Work's hub-anchored countdown.
    now: Date.now(),
    onHubMachine: onLoopback()
  })
  const resources = makeResourcesModuleViews({ host: current.host, read: resourcesRead })
  const code = makeCodeModuleViews({ reads: codeReads })
  const stacks = makeStacksModuleViews({ reads: stacksReads })
  // The page reads its caller; only the hub's own node sees and may use lease, extend and release.
  const sandboxes = current.approvalApp.sandboxesEnabled
    ? [
        makeSandboxesModuleViews({
          reads: sandboxesReads,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          writes: sandboxesWrites
        })
      ]
    : []
  const connectConnection = useAtomValue(atoms.connect.connection)
  const fleetNavigationBadge = dashboardPendingNavigationBadge(pendingState, workNow, refreshFailed)
  const fleetWithBadge =
    fleetNavigationBadge === undefined ? fleet : { ...fleet, navigationBadge: fleetNavigationBadge }
  const installed = [connect, fleetWithBadge, code, usage, resources, ...sandboxes, stacks]
  const layout = superappLayout(
    installed.map((view) => view.descriptor.id),
    current.approvalApp.fleet
  )
  return (
    <>
      <DashboardWorkPollOwner atom={atoms.work} poll={atoms.workPoll} />
      {superapp ? (
        <SuperappShell
          modules={installed.filter((view) => layout.modules.includes(view.descriptor.id))}
          mobileModules={layout.mobileModules}
          primaryModules={layout.primaryModules}
          landing={{ module: "connect", page: "overview" }}
          host={current.host}
          hostCount={hostCount}
          standalone={!current.approvalApp.fleet}
          session={
            refreshFailed
              ? { access: onLoopback() ? "loopback" : "tailscale", connection: "stale", observedAt: current.observedAt }
              : { access: onLoopback() ? "loopback" : "tailscale", connection: "connected" }
          }
          terminalOwnsKeys={connectConnection._tag === "connected"}
          relay={relay}
          onLocationChange={setRouteSearch}
          notifications={
            <>
              <NotificationPanel
                canonicalUrl={current.approvalApp.canonicalUrl}
                state={notificationState}
                onEnable={() => void onNotificationAction(true)}
                onDisable={() => void onNotificationAction(false)}
              />
              <ActivityHistory
                hasMore={current.historyNextCursor !== null}
                loading={historyBusy}
                onLoadMore={() => void onLoadHistory()}
                records={current.records}
              />
            </>
          }
        />
      ) : (
        <div className="dashboard-gesture" {...gesture}>
          {dashboardView}
        </div>
      )}
    </>
  )
}

const initialNode = document.querySelector("#fleet-dashboard-data")
const root = document.querySelector("#fleet-dashboard-root")
if (initialNode === null || root === null) {
  throw new DashboardBootstrapError({ cause: null, detail: "bootstrap nodes are missing" })
}
const initialResult = Schema.decodeUnknownResult(Schema.fromJsonString(DashboardSnapshot))(
  initialNode.textContent ?? ""
)
if (Result.isFailure(initialResult)) {
  throw new DashboardBootstrapError({
    cause: initialResult.failure,
    detail: "bootstrap snapshot is invalid"
  })
}
const initial = initialResult.success
const atoms = makeDashboardAtoms(initial)
/**
 * Relay's one conversation, on any listener that serves the super-app (the only ones that serve `/v1/relay`): one
 * stream for the page, closed when the page goes away for good.
 */
const applicationRuntime = ManagedRuntime.make(Layer.merge(BrowserHttpClient.layerFetch, BrowserCrypto.layer))
const readToday = Effect.callback<typeof NeedsYouResult.Type, TodayReadFailed>((resume, signal) => {
  applicationRuntime.runCallback(loadToday, {
    signal,
    onExit: (exit) => resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
  })
})
const usageReads: UsageModuleReads = {
  usage: (query) =>
    Effect.callback((resume, signal) => {
      applicationRuntime.runCallback(loadUsage(query), {
        signal,
        onExit: (exit) => resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
      })
    }),
  limits: Effect.callback((resume, signal) => {
    applicationRuntime.runCallback(loadLimits, {
      signal,
      onExit: (exit) => resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
    })
  })
}
/** The existing page runtime owns all Code fetches; module interruption aborts their request signals. */
const runCodeRead = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Effect.Effect<A, E> =>
  Effect.callback((resume, signal) => {
    applicationRuntime.runCallback(effect, {
      signal,
      onExit: (exit) => resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
    })
  })
const resourcesRead = runCodeRead(loadHostResources())
const codeReads: CodeModuleReads = {
  queue: (query) => runCodeRead(loadCodeQueue(query)),
  detail: (ref) => runCodeRead(loadCodeDetail(ref)),
  review: (ref) => runCodeRead(loadCodeReview(ref)),
  diff: (ref) => runCodeRead(loadCodeDiff(ref)),
  content: (query) => runCodeRead(loadCodeContent(query)),
  canvas: (ref) => runCodeRead(loadCodeCanvas(ref)),
  commit: (query) => runCodeRead(loadCodeCommit(query))
}
const stacksReads: StacksModuleReads = {
  overview: runCodeRead(loadStacksOverview),
  stack: (id) => runCodeRead(loadStack(id)),
  plan: (id) => runCodeRead(loadStackPlan(id))
}
const sandboxesReads: SandboxesModuleReads = {
  overview: runCodeRead(loadSandboxesOverview),
  caller: runCodeRead(loadSandboxesCaller)
}
/** The hub refuses these unless the page runs on its own node; the page shows them only to that owner. */
const sandboxesWrites: SandboxesModuleWrites = {
  lease: runCodeRead(submitSandboxJob({ _tag: "Lease" })).pipe(Effect.asVoid),
  extend: (accountId) => runCodeRead(submitSandboxJob({ _tag: "Extend", accountId })).pipe(Effect.asVoid),
  release: (accountId) => runCodeRead(submitSandboxJob({ _tag: "Release", accountId })).pipe(Effect.asVoid)
}
const relayConversations = makeRelayConversations(
  makeRelayClient({ base: "/v1/relay", origin: window.location.href }),
  applicationRuntime
)
const relay: HubRelayConversation = {
  conversations: relayConversations,
  conversation: { product: "herdr", kind: "fleet", id: initial.host }
}
watchRelayPage(window, relay)
const application = (
  <RegistryProvider>
    <DashboardApp atoms={atoms} readToday={readToday} usageReads={usageReads} codeReads={codeReads} />
  </RegistryProvider>
)
if (initial.approvalApp.superapp) createRoot(root).render(application)
else hydrateRoot(root, application)
