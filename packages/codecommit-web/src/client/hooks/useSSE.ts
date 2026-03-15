/**
 * SSE client hook — connects to /api/events/ and decodes state updates.
 *
 * {@link useSSE} opens an EventSource to `/api/events/`, decodes each
 * message into AppState (pull requests with approval rules and approver
 * ARNs, pending review count, notifications, sandboxes, permission
 * prompts), fires toasts for genuinely new notifications (suppressing
 * title_changed/description_changed), and reconnects with exponential
 * backoff up to 50 retries.
 *
 * **Gotchas**
 *
 * - `as AppState` cast works because only consoleUrl getter is missing from
 *   wire objects (it's a Schema.Class getter, not serialized)
 *
 * **Common tasks**
 *
 * - Connect SSE: {@link useSSE}
 * - Connection state: {@link ConnectionState}
 *
 * @module
 */
import { AppStatus, PullRequestStatus } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AppState } from "../atoms/app.js"

const PullRequestWire = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.DateFromString,
  lastModifiedDate: Schema.DateFromString,
  link: Schema.String,
  account: Schema.Struct({
    profile: Schema.String,
    region: Schema.String,
    awsAccountId: Schema.optional(Schema.String),
    repoAccountId: Schema.optional(Schema.String)
  }),
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean,
  commentCount: Schema.optional(Schema.Number),
  healthScore: Schema.optional(Schema.Number),
  fetchedAt: Schema.optional(Schema.DateFromString),
  approvedBy: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  approvedByArns: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  commentedBy: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  filesChanged: Schema.optional(Schema.Number),
  approvalRules: Schema.optionalWith(
    Schema.Array(Schema.Struct({
      ruleName: Schema.String,
      requiredApprovals: Schema.Number,
      poolMembers: Schema.Array(Schema.String),
      poolMemberArns: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
      satisfied: Schema.Boolean,
      fromTemplate: Schema.optional(Schema.String)
    })),
    { default: () => [] }
  )
})

const NotificationWire = Schema.Struct({
  id: Schema.Number,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  type: Schema.String,
  title: Schema.String,
  profile: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
  read: Schema.Number
})

const SandboxWire = Schema.Struct({
  id: Schema.String,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  status: Schema.String,
  statusDetail: Schema.NullOr(Schema.String),
  logs: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastActivityAt: Schema.String
})

const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequestWire),
  accounts: Schema.Array(Schema.Struct({
    profile: Schema.String,
    region: Schema.String,
    enabled: Schema.Boolean
  })),
  status: AppStatus,
  statusDetail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateFromString),
  currentUser: Schema.optional(Schema.String),
  pendingReviewCount: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  unreadNotificationCount: Schema.optional(Schema.Number),
  notifications: Schema.optional(Schema.Struct({
    items: Schema.Array(NotificationWire),
    nextCursor: Schema.optional(Schema.Number)
  })),
  sandboxes: Schema.optional(Schema.Array(SandboxWire)),
  permissionPrompt: Schema.optional(Schema.Struct({
    id: Schema.String,
    operation: Schema.String,
    category: Schema.String,
    context: Schema.String
  }))
})

const decode = Schema.decodeUnknownSync(Schema.parseJson(SsePayload))

export type ConnectionState = "connected" | "reconnecting" | "disconnected"

export function useSSE(
  onState: (state: AppState) => void,
  onToastClick?: (path?: string) => void,
  onDesktopNotify?: (
    n: { id?: number; type: string; title: string; message: string; awsAccountId?: string; pullRequestId?: string }
  ) => void
) {
  const callbackRef = useRef(onState)
  callbackRef.current = onState
  const toastClickRef = useRef(onToastClick)
  toastClickRef.current = onToastClick
  const desktopNotifyRef = useRef(onDesktopNotify)
  desktopNotifyRef.current = onDesktopNotify
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected")
  const maxSeenIdRef = useRef<number>(0)

  useEffect(() => {
    let es: EventSource | null = null
    let retryCount = 0
    let retryTimeout: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      es = new EventSource("/api/events/")

      es.onopen = () => {
        retryCount = 0
        setConnectionState("connected")
      }

      es.onmessage = (event) => {
        try {
          const state = decode(event.data) as AppState

          // Toast for genuinely new notifications
          const notifications = state.notifications?.items ?? []
          const suppressedToastTypes = new Set(["title_changed", "description_changed"])
          if (maxSeenIdRef.current > 0) {
            for (const n of notifications) {
              if (n.id > maxSeenIdRef.current && !suppressedToastTypes.has(n.type)) {
                toast(n.title || "New notification", {
                  id: `notif-${n.id}`,
                  description: n.message,
                  duration: 8000,
                  action: n.awsAccountId && n.pullRequestId
                    ? {
                      label: "View",
                      onClick: () => toastClickRef.current?.(`/accounts/${n.awsAccountId}/prs/${n.pullRequestId}`)
                    }
                    : { label: "View", onClick: () => toastClickRef.current?.("/notifications") }
                })
                desktopNotifyRef.current?.({
                  id: n.id,
                  type: n.type,
                  title: n.title || "CodeCommit",
                  message: n.message,
                  awsAccountId: n.awsAccountId,
                  pullRequestId: n.pullRequestId
                })
              }
            }
          }
          if (notifications.length > 0) {
            const maxId = Math.max(...notifications.map((n) => n.id))
            if (maxId > maxSeenIdRef.current) maxSeenIdRef.current = maxId
          }

          callbackRef.current(state)
        } catch (e) {
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn("SSE decode error:", e)
          }
        }
      }

      es.onerror = () => {
        es?.close()
        if (retryCount >= 50) {
          setConnectionState("disconnected")
          return
        }
        setConnectionState("reconnecting")
        const delay = Math.min(1000 * 2 ** retryCount, 30000)
        retryTimeout = setTimeout(() => {
          retryCount++
          connect()
        }, delay)
      }
    }

    connect()
    return () => {
      es?.close()
      if (retryTimeout) clearTimeout(retryTimeout)
    }
  }, [])

  return connectionState
}
