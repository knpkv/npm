import { AppStatus } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { useEffect, useRef } from "react"
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
  account: Schema.Struct({ id: Schema.String, region: Schema.String }),
  status: Schema.Literal("OPEN", "CLOSED"),
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean
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
  currentUser: Schema.optional(Schema.String)
})

const decode = Schema.decodeUnknownSync(Schema.parseJson(SsePayload))

export function useSSE(onState: (state: AppState) => void) {
  const callbackRef = useRef(onState)
  callbackRef.current = onState

  useEffect(() => {
    const es = new EventSource("/api/events/")
    es.onmessage = (event) => {
      try {
        callbackRef.current(decode(event.data) as AppState)
      } catch { /* ignore parse/decode errors */ }
    }
    return () => es.close()
  }, [])
}
