import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { SessionId } from "../../api/session.js"
import { EventCursor, type ReleaseId } from "../../domain/identifiers.js"
import { ReleaseServiceName, ReleaseVersion } from "../../domain/release.js"
import { ReleaseRelayCodename } from "../../domain/releaseRelay.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

const MAXIMUM_STORED_MESSAGES = 24
const MAXIMUM_STORED_CONTENT = 256_000

const StoredReleaseAgentTurnContext = Schema.Struct({
  eventCursor: EventCursor,
  relayCodename: ReleaseRelayCodename,
  serviceName: ReleaseServiceName,
  updatedAt: UtcTimestamp,
  version: ReleaseVersion
})

const StoredReleaseAgentThreadMessage = Schema.Struct({
  content: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32_000)),
  context: Schema.optionalKey(StoredReleaseAgentTurnContext),
  dateTime: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  provider: Schema.optionalKey(Schema.Literals(["codex", "claude"])),
  role: Schema.Literals(["user", "assistant"]),
  time: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32))
})

const StoredReleaseAgentThread = Schema.Array(StoredReleaseAgentThreadMessage).check(
  Schema.makeFilter((messages) => messages.length <= MAXIMUM_STORED_MESSAGES, {
    expected: `at most ${MAXIMUM_STORED_MESSAGES} stored release-agent messages`
  }),
  Schema.makeFilter(
    (messages) => messages.reduce((length, message) => length + message.content.length, 0) <= MAXIMUM_STORED_CONTENT,
    { expected: `at most ${MAXIMUM_STORED_CONTENT} stored release-agent characters` }
  )
)

const StoredReleaseAgentThreadJson = Schema.fromJsonString(StoredReleaseAgentThread)

export type StoredReleaseAgentThreadMessage = typeof StoredReleaseAgentThreadMessage.Type

const storageKey = (releaseId: ReleaseId): string | null => {
  const sessionId = sessionStorage.getItem("cc_session_id")
  if (sessionId === null || !Schema.is(SessionId)(sessionId)) return null
  return `cc_release_agent_thread:${sessionId}:${releaseId}`
}

const boundedStoredMessages = (
  messages: ReadonlyArray<StoredReleaseAgentThreadMessage>
): ReadonlyArray<StoredReleaseAgentThreadMessage> => {
  const bounded: Array<StoredReleaseAgentThreadMessage> = []
  let contentLength = 0
  for (const message of messages.slice(-MAXIMUM_STORED_MESSAGES).reverse()) {
    if (contentLength + message.content.length > MAXIMUM_STORED_CONTENT) break
    bounded.unshift(message)
    contentLength += message.content.length
  }
  return bounded
}

/** Recover only Schema-valid tab-local thread state for the exact release. */
export const readReleaseAgentThread = (
  releaseId: ReleaseId
): ReadonlyArray<StoredReleaseAgentThreadMessage> => {
  try {
    const key = storageKey(releaseId)
    if (key === null) return []
    const source = sessionStorage.getItem(key)
    if (source === null) return []
    const decoded = Schema.decodeUnknownResult(StoredReleaseAgentThreadJson)(source)
    return Result.isSuccess(decoded) ? decoded.success : []
  } catch {
    return []
  }
}

/** Persist a bounded release thread for the lifetime of the current browser tab. */
export const writeReleaseAgentThread = (
  releaseId: ReleaseId,
  messages: ReadonlyArray<StoredReleaseAgentThreadMessage>
): void => {
  const encoded = Schema.encodeUnknownResult(StoredReleaseAgentThreadJson)(boundedStoredMessages(messages))
  if (Result.isFailure(encoded)) return
  try {
    const key = storageKey(releaseId)
    if (key === null) return
    sessionStorage.setItem(key, encoded.success)
  } catch {
    // Storage can be unavailable in hardened browser contexts; the in-memory thread still works.
  }
}
