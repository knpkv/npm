/** Browser NDJSON client for sanitized Relay review progress. @module */
import { Data, Predicate, Schema } from "effect"

import {
  type RelayReviewContinueStreamRequest,
  RelayReviewStreamEvent,
  type RelayReviewStreamRequest
} from "../server/Api.js"
import { ownerSessionReady, readOwnerCsrfToken } from "./ownerSession.js"

export class RelayReviewTransportError extends Data.TaggedError("RelayReviewTransportError")<{
  readonly message: string
}> {}

const decodeEvent = Schema.decodeUnknownPromise(Schema.fromJsonString(RelayReviewStreamEvent))

/** Read every complete NDJSON frame while preserving partial UTF-8 chunks. */
export const runRelayReviewStream = async (
  url: string,
  payload: RelayReviewStreamRequest | RelayReviewContinueStreamRequest,
  onEvent: (event: RelayReviewStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> => {
  const status = await ownerSessionReady
  if (status._tag === "Failed") throw new RelayReviewTransportError({ message: status.message })
  const csrfToken = readOwnerCsrfToken()
  const headers = csrfToken === null
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", "x-csrf-token": csrfToken }
  const request: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(payload)
  }
  if (signal !== undefined) request.signal = signal
  const response = await window.fetch(url, request)
  if (!response.ok) {
    const message = (await response.text()).slice(0, 2_000).trim()
    throw new RelayReviewTransportError({
      message: message.length === 0 ? `Relay request failed with status ${response.status}` : message
    })
  }
  if (response.body === null) throw new RelayReviewTransportError({ message: "Relay returned no progress stream" })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let terminalSeen = false
  const consume = async (line: string): Promise<void> => {
    if (line.trim().length === 0) return
    try {
      const event = await decodeEvent(line)
      if (terminalSeen) {
        throw new RelayReviewTransportError({ message: "Relay returned frames after the terminal event" })
      }
      terminalSeen = event.type === "complete" || event.type === "error"
      onEvent(event)
    } catch (cause) {
      if (Predicate.isTagged(cause, "RelayReviewTransportError")) throw cause
      throw new RelayReviewTransportError({
        message: Predicate.isError(cause) ? cause.message : "Relay returned malformed progress"
      })
    }
  }
  while (true) {
    const next = await reader.read()
    buffered += decoder.decode(next.value, { stream: !next.done })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) await consume(line)
    if (next.done) break
  }
  await consume(buffered)
  if (!terminalSeen) {
    throw new RelayReviewTransportError({ message: "Relay progress stream ended before a terminal event" })
  }
}
