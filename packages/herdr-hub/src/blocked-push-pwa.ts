import type { BlockedPushPayload } from "./blocked-push-model.js"
import { approvalDeepLink, type ApprovalWorkerRegistration } from "./pwa.js"

/** Notification taps use the canonical origin and the stable agent identity, never a terminal URL. */
export const blockedPushDeepLink = (canonicalUrl: string, payload: BlockedPushPayload): string => {
  if (payload.approvalJobId !== null) {
    return approvalDeepLink(canonicalUrl, { host: payload.host, jobId: payload.approvalJobId })
  }
  const url = new URL("/connect/", canonicalUrl)
  url.searchParams.set("host", payload.host)
  url.searchParams.set("agent", payload.agentId)
  url.searchParams.set("open", "stage")
  return url.href
}

export const showBlockedNotification = (
  registration: ApprovalWorkerRegistration,
  payload: BlockedPushPayload
): Promise<void> => {
  const state = payload.state === "blocked" ? `${payload.agentName} is blocked` : `${payload.agentName} needs you`
  return registration.showNotification(`${payload.agentName} needs you`, {
    badge: "/assets/relay-badge-96.png",
    icon: "/assets/relay-192.png",
    body: payload.firstLine === state ? state : `${state}. ${payload.firstLine}`,
    tag: `agent-blocked:${payload.host.toLowerCase()}:${payload.agentId}`,
    data: payload
  })
}
