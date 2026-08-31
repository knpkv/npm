/** Schema-validated durable storage for per-PR Relay conversations. @module */
import { Data, Result, Schema } from "effect"

import { PullRequestRelayReviewResponse, RelayReviewConversationTurns, RelayReviewSkillIds } from "../server/Api.js"
import { appendReviewTurn, FindingDisposition, type FindingDispositions } from "./review-session-state.js"

export const RelayReviewSessionResourceIdentity = Schema.Struct({
  accountId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  pullRequestId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  region: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  repositoryName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
})
export interface RelayReviewSessionResourceIdentity extends
  Schema.Schema.Type<
    typeof RelayReviewSessionResourceIdentity
  >
{}

const StoredRelayReviewSession = Schema.Struct({
  identity: Schema.String,
  resource: RelayReviewSessionResourceIdentity,
  review: PullRequestRelayReviewResponse,
  skillIds: RelayReviewSkillIds,
  turns: RelayReviewConversationTurns,
  dispositions: Schema.Record(Schema.String, FindingDisposition),
  version: Schema.Int.check(Schema.isGreaterThan(0))
})

export type StoredRelayReviewSession = typeof StoredRelayReviewSession.Type

export interface RelayReviewSessionWrite {
  readonly dispositions: FindingDispositions
  readonly expectedIdentity: string
  /** Version observed when this tab read the durable session. */
  readonly expectedVersion: number
  readonly identity: string
  readonly resource: RelayReviewSessionResourceIdentity
  readonly review: PullRequestRelayReviewResponse
  readonly skillIds: typeof RelayReviewSkillIds.Type
  readonly turns: typeof RelayReviewConversationTurns.Type
}

export type RelayReviewSessionWriteOutcome =
  | { readonly _tag: "stored"; readonly session: StoredRelayReviewSession }
  | { readonly _tag: "stale-review-preserved"; readonly session: StoredRelayReviewSession }

const decodeStoredSession = Schema.decodeUnknownResult(Schema.fromJsonString(StoredRelayReviewSession))

export class RelayReviewSessionStorageUnavailable extends Data.TaggedError("RelayReviewSessionStorageUnavailable")<{
  readonly operation: "read" | "write"
}> {}

export class RelayReviewSessionInvalid extends Data.TaggedError("RelayReviewSessionInvalid")<{}> {}

export class RelayReviewSessionResourceMismatch extends Data.TaggedError("RelayReviewSessionResourceMismatch")<{}> {}

export type RelayReviewSessionReadFailure =
  | RelayReviewSessionStorageUnavailable
  | RelayReviewSessionInvalid
  | RelayReviewSessionResourceMismatch

interface RelayReviewSessionReadableStorage {
  readonly getItem: (key: string) => string | null
}

interface RelayReviewSessionWritableStorage {
  readonly setItem: (key: string, value: string) => void
}

const recoverInterruptedPublications = (
  dispositions: StoredRelayReviewSession["dispositions"]
): StoredRelayReviewSession["dispositions"] =>
  Object.entries(dispositions).reduce<StoredRelayReviewSession["dispositions"]>(
    (recovered, [findingId, disposition]) => ({
      ...recovered,
      [findingId]: disposition === "posting" ? "failed" : disposition
    }),
    {}
  )

const sameResource = (left: RelayReviewSessionResourceIdentity, right: RelayReviewSessionResourceIdentity): boolean =>
  left.accountId === right.accountId &&
  left.pullRequestId === right.pullRequestId &&
  left.region === right.region &&
  left.repositoryName === right.repositoryName

const dispositionRank = (disposition: FindingDisposition): number => {
  switch (disposition) {
    case "pending":
      return 0
    case "acknowledged":
    case "failed":
    case "rejected":
      return 1
    case "posting":
      return 2
    case "posted-stale":
      return 3
    case "posted":
      return 4
  }
}

const mergeDispositions = (current: FindingDispositions, incoming: FindingDispositions): FindingDispositions =>
  Object.entries(incoming).reduce<FindingDispositions>((merged, [findingId, disposition]) => {
    const existing = merged[findingId]
    return existing !== undefined && dispositionRank(existing) > dispositionRank(disposition)
      ? merged
      : { ...merged, [findingId]: disposition }
  }, current)

const mergeTurns = (
  current: typeof RelayReviewConversationTurns.Type,
  incoming: typeof RelayReviewConversationTurns.Type
): typeof RelayReviewConversationTurns.Type => {
  const turnIdentity = (turn: (typeof RelayReviewConversationTurns.Type)[number]): string =>
    turn.id ?? JSON.stringify(turn)
  const identities = new Set(current.map(turnIdentity))
  return incoming.reduce<typeof RelayReviewConversationTurns.Type>((merged, turn) => {
    const identity = turnIdentity(turn)
    if (identities.has(identity)) return merged
    identities.add(identity)
    return appendReviewTurn(merged, turn)
  }, current)
}

const storedSession = (
  incoming: RelayReviewSessionWrite,
  turns: typeof RelayReviewConversationTurns.Type,
  version: number
): StoredRelayReviewSession => ({
  dispositions: incoming.dispositions,
  identity: incoming.identity,
  resource: incoming.resource,
  review: incoming.review,
  skillIds: incoming.skillIds,
  turns,
  version
})

const mergeStoredSession = (
  current: StoredRelayReviewSession,
  incoming: RelayReviewSessionWrite
): RelayReviewSessionWriteOutcome => {
  const turns = mergeTurns(current.turns, incoming.turns)
  const observedCurrentVersion = incoming.expectedVersion === current.version
  if (!observedCurrentVersion) {
    const dispositions = mergeDispositions(current.dispositions, incoming.dispositions)
    return {
      _tag: "stale-review-preserved",
      session: { ...current, dispositions, turns, version: current.version + 1 }
    }
  }
  const sameHead = current.identity === incoming.identity
  const expectedHead = current.identity === incoming.expectedIdentity
  if (sameHead) {
    return {
      _tag: "stored",
      session: storedSession(incoming, turns, current.version + 1)
    }
  }
  if (expectedHead) {
    return { _tag: "stored", session: storedSession(incoming, turns, current.version + 1) }
  }
  const dispositions = mergeDispositions(current.dispositions, incoming.dispositions)
  return {
    _tag: "stale-review-preserved",
    session: { ...current, dispositions, turns, version: current.version + 1 }
  }
}

/** Keep one durable review session per pull request; its exact reviewed head remains explicit inside the payload. */
export const relayReviewSessionStorageKey = (identity: RelayReviewSessionResourceIdentity): string =>
  `codecommit:relay-review-session:${encodeURIComponent(identity.accountId)}:${
    encodeURIComponent(
      identity.repositoryName
    )
  }:${encodeURIComponent(identity.region)}:${encodeURIComponent(identity.pullRequestId)}`

export const readRelayReviewSession = (
  storage: RelayReviewSessionReadableStorage,
  key: string,
  expectedResource: RelayReviewSessionResourceIdentity
): Result.Result<StoredRelayReviewSession | null, RelayReviewSessionReadFailure> => {
  const encoded = Result.try({
    try: () => storage.getItem(key),
    catch: () => new RelayReviewSessionStorageUnavailable({ operation: "read" })
  })
  if (Result.isFailure(encoded)) return Result.fail(encoded.failure)
  if (encoded.success === null) return Result.succeed(null)
  const decoded = decodeStoredSession(encoded.success)
  if (Result.isFailure(decoded)) return Result.fail(new RelayReviewSessionInvalid())
  if (!sameResource(decoded.success.resource, expectedResource)) {
    return Result.fail(new RelayReviewSessionResourceMismatch())
  }
  return Result.succeed({
    ...decoded.success,
    dispositions: recoverInterruptedPublications(decoded.success.dispositions)
  })
}

export const writeRelayReviewSession = (
  storage: RelayReviewSessionReadableStorage & RelayReviewSessionWritableStorage,
  key: string,
  session: RelayReviewSessionWrite
): Result.Result<RelayReviewSessionWriteOutcome, RelayReviewSessionReadFailure> => {
  const existing = readRelayReviewSession(storage, key, session.resource)
  if (Result.isFailure(existing)) return Result.fail(existing.failure)
  const outcome: RelayReviewSessionWriteOutcome = existing.success === null
    ? { _tag: "stored", session: storedSession(session, session.turns, 1) }
    : mergeStoredSession(existing.success, session)
  return Result.try({
    try: () => {
      storage.setItem(key, JSON.stringify(outcome.session))
      return outcome
    },
    catch: () => new RelayReviewSessionStorageUnavailable({ operation: "write" })
  })
}
