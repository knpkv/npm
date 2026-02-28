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
    awsAccountId: Schema.optional(Schema.String)
  }),
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean,
  commentCount: Schema.optional(Schema.Number),
  healthScore: Schema.optional(Schema.Number),
  fetchedAt: Schema.optional(Schema.DateFromString)
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
  unreadNotificationCount: Schema.optional(Schema.Number),
  notifications: Schema.optional(Schema.Struct({
    items: Schema.Array(NotificationWire),
    nextCursor: Schema.optional(Schema.Number)
  }))
})

const decode = Schema.decodeUnknownSync(Schema.parseJson(SsePayload))

export type ConnectionState = "connected" | "reconnecting" | "disconnected"

export function useSSE(onState: (state: AppState) => void, onToastClick?: () => void) {
  const callbackRef = useRef(onState)
  callbackRef.current = onState
  const toastClickRef = useRef(onToastClick)
  toastClickRef.current = onToastClick
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
          if (maxSeenIdRef.current > 0) {
            for (const n of notifications) {
              if (n.id > maxSeenIdRef.current) {
                toast(n.title || "New notification", {
                  description: n.message,
                  action: { label: "View", onClick: () => toastClickRef.current?.() }
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
