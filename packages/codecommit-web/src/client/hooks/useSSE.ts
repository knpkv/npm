import { AppStatus } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"
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
  account: Schema.Struct({ profile: Schema.String, region: Schema.String, awsAccountId: Schema.optional(Schema.String) }),
  status: Schema.Literal("OPEN", "CLOSED"),
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean,
  commentCount: Schema.optional(Schema.Number)
})

const NotificationItemWire = Schema.Struct({
  type: Schema.Literal("error", "info", "warning", "success"),
  title: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  profile: Schema.optional(Schema.String)
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
  notifications: Schema.optional(Schema.Array(NotificationItemWire)),
  unreadNotificationCount: Schema.optional(Schema.Number)
})

const decode = Schema.decodeUnknownSync(Schema.parseJson(SsePayload))

export type ConnectionState = "connected" | "reconnecting" | "disconnected"

export function useSSE(onState: (state: AppState) => void) {
  const callbackRef = useRef(onState)
  callbackRef.current = onState
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected")

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
          callbackRef.current(decode(event.data) as unknown as AppState)
        } catch {
          // decode errors are non-fatal
        }
      }

      es.onerror = () => {
        es?.close()
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
