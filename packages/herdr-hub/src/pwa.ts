import { Effect, Result, Schema } from "effect"
import { ApprovalNotificationCandidate, type ApprovalPushPayload, type PushPayload } from "./model.js"

export class ApprovalDeepLinkError extends Schema.TaggedError<ApprovalDeepLinkError>()(
  "ApprovalDeepLinkError",
  { cause: Schema.Defect() }
) {}

export type ApprovalWorkerRegistration = {
  readonly scope: string
  readonly showNotification: (
    title: string,
    options: {
      readonly badge: string
      readonly body: string
      readonly data: PushPayload
      readonly icon: string
      readonly tag: string
      readonly renotify?: boolean
    }
  ) => Promise<void>
}

/** A window the notification click may focus. */
export type ApprovalWorkerFocusTarget = {
  readonly focus: () => Promise<void>
}

export type ApprovalWorkerClient = ApprovalWorkerFocusTarget & {
  /** Return the navigated client to focus, or null when the browser cannot navigate this client. */
  readonly navigate: (url: string) => Promise<ApprovalWorkerFocusTarget | null>
  readonly url: string
}

export type ApprovalWorkerClients = {
  /** Return only window clients controlled by the notification service worker. */
  readonly matchAll: (
    options: { readonly includeUncontrolled: false; readonly type: "window" }
  ) => Promise<ReadonlyArray<ApprovalWorkerClient>>
  readonly openWindow: (url: string) => Promise<void>
}

export const showApprovalNotification = async (
  registration: ApprovalWorkerRegistration,
  setBadge: (count: number) => Promise<void>,
  payload: ApprovalPushPayload
): Promise<void> => {
  const pendingCount = payload.pendingCount
  const badge = pendingCount === null
    ? Result.succeed(undefined)
    : await Effect.runPromise(
      Effect.result(Effect.tryPromise(() => setBadge(pendingCount)))
    )
  await registration.showNotification(`Approval needed on ${payload.host}`, {
    badge: "/assets/relay-badge-96.png",
    body: `Job ${payload.jobId} is waiting for approval.`,
    data: payload,
    icon: "/assets/relay-192.png",
    tag: `approval:${payload.host}:${payload.jobId}`
  })
  if (Result.isFailure(badge)) throw badge.failure
}

export const approvalDeepLink = (
  canonicalUrl: string,
  payload: ApprovalNotificationCandidate
): string => {
  const url = new URL(canonicalUrl)
  url.searchParams.set("tab", "approvals")
  url.searchParams.set("approvalHost", payload.host)
  url.searchParams.set("approvalJob", payload.jobId)
  return url.href
}

export const readApprovalDeepLink = (search: string) => {
  const parameters = new URLSearchParams(search)
  const host = parameters.get("approvalHost")
  const jobId = parameters.get("approvalJob")
  if (host === null && jobId === null) return Result.succeed(null)
  const decoded = Schema.decodeUnknownResult(ApprovalNotificationCandidate)({ host, jobId })
  return Result.isFailure(decoded)
    ? Result.fail(new ApprovalDeepLinkError({ cause: decoded.failure }))
    : Result.succeed(decoded.success)
}

export const matchesApprovalDeepLink = (
  dataset: {
    readonly approvalHost?: string
    readonly approvalJob?: string
  },
  target: ApprovalNotificationCandidate
): boolean =>
  dataset.approvalHost?.toLowerCase() === target.host.toLowerCase() &&
  dataset.approvalJob === target.jobId

/** Navigate before spending the click's sole interaction grant on focus or fallback opening. */
export const handleNotificationClick = async (
  clients: ApprovalWorkerClients,
  deepLinkUrl: string
): Promise<void> => {
  const target = new URL(deepLinkUrl)
  const navigated = await Effect.runPromise(Effect.result(Effect.tryPromise(async () => {
    const windows = await clients.matchAll({ includeUncontrolled: false, type: "window" })
    const canonical = windows.find((client) => new URL(client.url).origin === target.origin)
    return canonical === undefined ? null : await canonical.navigate(deepLinkUrl)
  })))
  if (Result.isFailure(navigated) || navigated.success === null) {
    await clients.openWindow(deepLinkUrl)
    return
  }
  await navigated.success.focus()
}
