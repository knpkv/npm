import { Effect, Result, Schema } from "effect"
import { ApprovalNotificationCandidate, type ApprovalPushPayload } from "./model.js"

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
      readonly data: ApprovalPushPayload
      readonly icon: string
      readonly tag: string
    }
  ) => Promise<void>
}

export type ApprovalWorkerClient = {
  readonly focus: () => Promise<void>
  readonly navigate: (url: string) => Promise<void>
  readonly url: string
}

export type ApprovalWorkerClients = {
  readonly matchAll: () => Promise<ReadonlyArray<ApprovalWorkerClient>>
  readonly openWindow: (url: string) => Promise<void>
}

export const showApprovalNotification = async (
  registration: ApprovalWorkerRegistration,
  setBadge: (count: number) => Promise<void>,
  payload: ApprovalPushPayload
): Promise<void> => {
  const badge = await Effect.runPromise(
    Effect.result(Effect.tryPromise(() => setBadge(payload.pendingCount)))
  )
  await registration.showNotification(`Approval needed on ${payload.host}`, {
    badge: "/assets/approval-icon.svg",
    body: `Job ${payload.jobId} is waiting for approval.`,
    data: payload,
    icon: "/assets/approval-icon.svg",
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

export const handleNotificationClick = async (
  clients: ApprovalWorkerClients,
  deepLinkUrl: string
): Promise<void> => {
  const windows = await clients.matchAll()
  const target = new URL(deepLinkUrl)
  const canonical = windows.find((client) => new URL(client.url).origin === target.origin)
  if (canonical !== undefined) {
    await canonical.navigate(deepLinkUrl)
    await canonical.focus()
    return
  }
  await clients.openWindow(deepLinkUrl)
}
