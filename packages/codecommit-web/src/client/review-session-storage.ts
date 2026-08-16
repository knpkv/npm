/** Schema-validated tab storage for exact-revision Relay conversations. @module */
import { Option, Schema } from "effect"

import { PullRequestRelayReviewResponse, RelayReviewConversationTurns, RelayReviewSkillIds } from "../server/Api.js"
import { FindingDisposition } from "./review-session-state.js"

const StoredRelayReviewSession = Schema.Struct({
  identity: Schema.String,
  review: PullRequestRelayReviewResponse,
  skillIds: RelayReviewSkillIds,
  turns: RelayReviewConversationTurns,
  dispositions: Schema.Record(Schema.String, FindingDisposition)
})

export type StoredRelayReviewSession = typeof StoredRelayReviewSession.Type

const decodeStoredSession = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRelayReviewSession))

/** Keep one review session per pull request; the decoded exact identity prevents cross-head restoration. */
export const relayReviewSessionStorageKey = (accountId: string, pullRequestId: string): string =>
  `codecommit:relay-review-session:${encodeURIComponent(accountId)}:${encodeURIComponent(pullRequestId)}`

export const readRelayReviewSession = (
  storage: Storage,
  key: string,
  expectedIdentity: string
): StoredRelayReviewSession | null => {
  try {
    const encoded = storage.getItem(key)
    if (encoded === null) return null
    const decoded = decodeStoredSession(encoded)
    return Option.isSome(decoded) && decoded.value.identity === expectedIdentity ? decoded.value : null
  } catch {
    return null
  }
}

export const writeRelayReviewSession = (
  storage: Storage,
  key: string,
  session: StoredRelayReviewSession
): void => {
  try {
    storage.setItem(key, JSON.stringify(session))
  } catch {
    // A blocked or full session store must not break the active in-memory review.
  }
}
