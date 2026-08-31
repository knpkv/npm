import { RegistryProvider, useAtom, useAtomMount, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { ConnectSurface, makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { StatePanel } from "@knpkv/rly/primitives"
import { Cause, Effect, Exit, Result, Schedule, Schema } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { useEffect, useRef, useState, type TouchEvent } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { ChatEntry, ChatHistory, type ChatMode, type ChatRequest } from "@knpkv/herdr-coordinator/model"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { JobRecord } from "@knpkv/herdr-fleet/model"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { WorkBoard } from "@knpkv/herdr-work/react"
import { PushPublicConfiguration, PushSubscriptionRecord, PushSubscriptionStatus } from "./model.js"
import {
  reconcileCurrentPushSubscription,
  reconcilePushSubscriptionState,
  registerNewPushSubscription,
  unregisterPushSubscription
} from "./push-subscription.js"
import { CoordinatorChatPanel, type NotificationState } from "./approval-app-view.js"
import { ActivityHistory } from "./activity-history.js"
import {
  DashboardSnapshot,
  type DashboardSnapshot as DashboardSnapshotType,
  DashboardHistoryPage,
  PendingApprovalTarget,
  type PendingApprovalTarget as PendingApprovalTargetType
} from "./dashboard-model.js"
import { AgentActivity, DashboardView, type ApprovalDecision } from "./dashboard-view.js"
import { FleetShell } from "./shell-view.js"
import { matchesApprovalDeepLink, readApprovalDeepLink } from "./pwa.js"

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

type BrowserRequest = { readonly method?: "GET" } | { readonly body: string; readonly method: "DELETE" | "POST" }

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
    init !== undefined && "body" in init
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

const withPendingApprovalTarget = (
  snapshot: DashboardSnapshotType,
  target: PendingApprovalTargetType | null
): DashboardSnapshotType => {
  if (target === null) return snapshot
  if (target._tag === "local") {
    return snapshot.pendingApprovals.local.some(({ id }) => id === target.record.id)
      ? snapshot
      : {
          ...snapshot,
          pendingApprovals: {
            ...snapshot.pendingApprovals,
            local: [...snapshot.pendingApprovals.local, target.record]
          }
        }
  }
  return snapshot.pendingApprovals.remote.some(
    ({ approval, host }) =>
      approval.id === target.remote.approval.id && host.toLowerCase() === target.remote.host.toLowerCase()
  )
    ? snapshot
    : {
        ...snapshot,
        pendingApprovals: {
          ...snapshot.pendingApprovals,
          remote: [...snapshot.pendingApprovals.remote, target.remote]
        }
      }
}

const decide = Effect.fn("Dashboard.decide")(function* (decision: ApprovalDecision) {
  yield* fetchJson(JobRecord, `/v1/jobs/${encodeURIComponent(decision.jobId)}/${decision.decision}`, {
    body: JSON.stringify({ hash: decision.hash, nonce: decision.nonce }),
    method: "POST"
  })
})

const loadChat = fetchJson(ChatHistory, "/v1/chat")
const loadWork = fetchJson(WorkSnapshots, "/v1/work")

const sendChat = Effect.fn("CoordinatorChat.send")(function* (request: ChatRequest) {
  return yield* fetchJson(ChatEntry, "/v1/chat", {
    body: JSON.stringify(request),
    method: "POST"
  })
})

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

const applicationServerKey = (encoded: string): ArrayBuffer => {
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4)
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/") + padding
  const bytes = atob(base64)
  const buffer = new ArrayBuffer(bytes.length)
  const view = new Uint8Array(buffer)
  for (let index = 0; index < bytes.length; index += 1) {
    view[index] = bytes.charCodeAt(index)
  }
  return buffer
}

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
  const chat = browserRuntime.atom(loadChat, {
    initialValue: initial.chat ?? { entries: [] }
  })
  const work = browserRuntime.atom(loadWork)
  const chatPoll = browserRuntime.atom(
    initial.approvalApp.chatEnabled
      ? Atom.refresh(chat).pipe(Effect.repeat(Schedule.spaced("3 seconds")))
      : Effect.never
  )
  return {
    badge: browserRuntime.fn(setApprovalBadge),
    busyChat: Atom.make(false),
    busyJob: Atom.make<string | null>(null),
    chat,
    chatPoll,
    chatSend: browserRuntime.fn(sendChat),
    connect: makeConnectAtoms(),
    dashboard: browserRuntime.atom(loadDashboard, { initialValue: initial }),
    decision: browserRuntime.fn(decide),
    notification: browserRuntime.atom<NotificationState, NotificationLoadError>(loadNotificationState, {
      initialValue: "loading"
    }),
    notificationAction: browserRuntime.fn((enable: boolean) =>
      enable ? enableNotifications() : disableNotifications()
    ),
    historyPage: browserRuntime.fn(loadDashboardHistory),
    pendingTarget: browserRuntime.fn(loadPendingApprovalTarget),
    pull: Atom.make<PullState>(initialPull),
    work
  }
}

type DashboardAtoms = ReturnType<typeof makeDashboardAtoms>

const DashboardApp = ({ atoms }: { readonly atoms: DashboardAtoms }) => {
  const result = useAtomValue(atoms.dashboard)
  const chatResult = useAtomValue(atoms.chat)
  const workResult = useAtomValue(atoms.work)
  const notificationResult = useAtomValue(atoms.notification)
  const refresh = useAtomRefresh(atoms.dashboard)
  const refreshChat = useAtomRefresh(atoms.chat)
  const refreshWork = useAtomRefresh(atoms.work)
  const refreshNotification = useAtomRefresh(atoms.notification)
  const runDecision = useAtomSet(atoms.decision, { mode: "promiseExit" })
  const runChat = useAtomSet(atoms.chatSend, { mode: "promiseExit" })
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
  const [busyJobId, setBusyJobId] = useAtom(atoms.busyJob)
  const [busyChat, setBusyChat] = useAtom(atoms.busyChat)
  const [pull, setPull] = useAtom(atoms.pull)
  const [deepLinkTarget, setDeepLinkTarget] = useState<PendingApprovalTargetType | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyRecords, setHistoryRecords] = useState<DashboardSnapshotType["records"]>([])
  const [historyNextCursor, setHistoryNextCursor] = useState(initial.historyNextCursor)
  const start = useRef<number | null>(null)
  useAtomMount(atoms.chatPoll)

  const resetPull = (): void => {
    start.current = null
    setPull(initialPull)
  }
  const refreshDashboard = (): void => {
    setPull({ ...initialPull, refreshing: true })
    refresh()
    refreshChat()
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
  const onDecision = async (decision: ApprovalDecision): Promise<void> => {
    setBusyJobId(decision.jobId)
    const exit = await runDecision(decision)
    setBusyJobId(null)
    if (Exit.isSuccess(exit)) {
      setDeepLinkTarget(null)
      refreshDashboard()
    }
  }
  const onChatSubmit = async (mode: ChatMode, message: string): Promise<boolean> => {
    setBusyChat(true)
    const exit = await runChat({ message, mode })
    setBusyChat(false)
    if (Exit.isSuccess(exit)) {
      refreshChat()
      refresh()
      return true
    }
    return false
  }
  const onNotificationAction = async (enable: boolean): Promise<void> => {
    await runNotificationAction(enable)
    refreshNotification()
  }
  const onLoadHistory = async (): Promise<void> => {
    if (historyNextCursor === null || historyBusy) return
    setHistoryBusy(true)
    const exit = await runHistoryPage(historyNextCursor)
    setHistoryBusy(false)
    if (Exit.isFailure(exit)) {
      Effect.runFork(Effect.logWarning(Cause.pretty(exit.cause)))
      return
    }
    setHistoryRecords((records) => [...records, ...exit.value.records])
    setHistoryNextCursor(exit.value.nextCursor)
  }

  const snapshot = AsyncResult.isSuccess(result)
    ? result.value
    : result._tag === "Failure" && result.previousSuccess._tag === "Some"
      ? result.previousSuccess.value.value
      : null
  const chat = AsyncResult.isSuccess(chatResult)
    ? chatResult.value
    : chatResult._tag === "Failure" && chatResult.previousSuccess._tag === "Some"
      ? chatResult.previousSuccess.value.value
      : snapshot?.chat
  const work = AsyncResult.isSuccess(workResult)
    ? workResult.value
    : workResult._tag === "Failure" && workResult.previousSuccess._tag === "Some"
      ? workResult.previousSuccess.value.value
      : snapshot?.work
  const notificationState: NotificationState = AsyncResult.isSuccess(notificationResult)
    ? notificationResult.value
    : notificationResult._tag === "Failure"
      ? "error"
      : "loading"
  const waiting = AsyncResult.isWaiting(result)
  const pendingBadgeCount =
    (snapshot?.pendingApprovals.local.length ?? 0) + (snapshot?.pendingApprovals.remote.length ?? 0)
  const canonical = snapshot?.approvalApp.canonical === true
  const currentSnapshot =
    snapshot === null
      ? null
      : withPendingApprovalTarget(
          {
            ...(chat === undefined && work === undefined
              ? snapshot
              : { ...snapshot, chat: chat ?? null, work: work ?? null }),
            historyNextCursor,
            records: [...snapshot.records, ...historyRecords]
          },
          deepLinkTarget
        )
  useEffect(() => {
    if (!waiting && pull.refreshing) {
      setPull(initialPull)
    }
  }, [pull.refreshing, setPull, waiting])
  useEffect(() => {
    if (!canonical || !pushSupported()) return
    void runBadge(pendingBadgeCount).then((exit) => {
      if (Exit.isFailure(exit)) {
        Effect.runFork(Effect.logError(Cause.pretty(exit.cause)))
      }
    })
  }, [canonical, pendingBadgeCount, runBadge])
  useEffect(() => {
    if (snapshot === null) return
    setHistoryRecords([])
    setHistoryNextCursor(snapshot.historyNextCursor)
  }, [snapshot?.observedAt])
  useEffect(() => {
    if (currentSnapshot === null) return
    const decoded = readApprovalDeepLink(window.location.search)
    if (Result.isFailure(decoded)) {
      Effect.runFork(Effect.logWarning(decoded.failure))
      return
    }
    if (decoded.success === null) return
    const loaded =
      currentSnapshot.pendingApprovals.local.some(
        ({ id }) =>
          id === decoded.success?.jobId && currentSnapshot.host.toLowerCase() === decoded.success?.host.toLowerCase()
      ) ||
      currentSnapshot.pendingApprovals.remote.some(
        ({ approval, host }) =>
          approval.id === decoded.success?.jobId && host.toLowerCase() === decoded.success?.host.toLowerCase()
      )
    if (!loaded && deepLinkTarget === null) {
      void runPendingTarget(decoded.success).then((exit) => {
        if (Exit.isSuccess(exit)) setDeepLinkTarget(exit.value)
        else Effect.runFork(Effect.logWarning(Cause.pretty(exit.cause)))
      })
      return
    }
    const target = [...document.querySelectorAll<HTMLElement>("[data-agenda-item]")].find((item) =>
      matchesApprovalDeepLink(item.dataset, decoded.success)
    )
    if (target === undefined) return
    target.dataset.approvalTarget = "true"
    target.focus({ preventScroll: true })
    target.scrollIntoView({ behavior: "smooth", block: "center" })
    return () => {
      delete target.dataset.approvalTarget
    }
  }, [currentSnapshot?.observedAt, deepLinkTarget, runPendingTarget])
  if (currentSnapshot === null) {
    return (
      <main className="app app-error">
        <h1>Host activity unavailable</h1>
        <pre>{result._tag === "Failure" ? Cause.pretty(result.cause) : "Loading host activity"}</pre>
      </main>
    )
  }
  const current = currentSnapshot
  const dashboardView = (
    <DashboardView
      approvalOnly={canonical}
      busyJobId={busyJobId}
      chatBusy={busyChat}
      historyLoading={historyBusy}
      notificationState={notificationState}
      onChatSubmit={onChatSubmit}
      onDecision={(decision) => void onDecision(decision)}
      onDisableNotifications={() => void onNotificationAction(false)}
      onEnableNotifications={() => void onNotificationAction(true)}
      onLoadHistory={() => void onLoadHistory()}
      onRefresh={refreshDashboard}
      pull={pull}
      showHeader={!canonical}
      snapshot={current}
    />
  )
  return (
    <div
      className="dashboard-gesture"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={resetPull}
    >
      {canonical ? (
        <FleetShell
          approvals={dashboardView}
          connect={
            <ConnectSurface
              atoms={atoms.connect}
              embedded
              roomFooter={
                current.chat === null ? null : (
                  <CoordinatorChatPanel busy={busyChat} history={current.chat} onSubmit={onChatSubmit} />
                )
              }
            />
          }
          hostCount={current.directory === null ? 1 : current.directory.links.length + 1}
          work={
            <section className="fleet-workspace">
              {current.work === null ? (
                <StatePanel
                  description="No durable goal projection is configured on this host. Live agent and job activity remain available below."
                  title="Goals unavailable"
                  tone="neutral"
                />
              ) : (
                <WorkBoard snapshots={current.work} />
              )}
              <AgentActivity snapshot={current} />
              <ActivityHistory
                hasMore={current.historyNextCursor !== null}
                loading={historyBusy}
                onLoadMore={() => void onLoadHistory()}
                records={current.records}
              />
            </section>
          }
        />
      ) : (
        dashboardView
      )}
    </div>
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
const application = (
  <RegistryProvider>
    <DashboardApp atoms={atoms} />
  </RegistryProvider>
)
if (initial.approvalApp.canonical) createRoot(root).render(application)
else hydrateRoot(root, application)
