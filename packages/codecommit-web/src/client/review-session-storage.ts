/** Schema-validated durable storage for per-PR Relay conversations. @module */
import { Data, Result, Schema } from "effect"

import {
  MAXIMUM_RELAY_REVIEW_TURNS,
  PullRequestRelayReviewResponse,
  RelayReviewConversationTurns,
  RelayReviewSkillIds
} from "../server/Api.js"
import {
  appendReviewTurn,
  FindingDisposition,
  type FindingDispositions,
  reconcileReviewConversationTurns
} from "./review-session-state.js"

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
  /** Identifies the ordered exchange appended after this tab's observed durable snapshot. */
  readonly appendedTurnIds?: ReadonlyArray<string>
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

/** Serialize the read/merge/write transaction across browser tabs. */
export interface RelayReviewSessionLock {
  readonly request: <A>(name: string, effect: () => Promise<A>) => Promise<A>
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
  const identities = new Set(current.map(turnIdentity))
  return incoming.reduce<typeof RelayReviewConversationTurns.Type>((merged, turn) => {
    const identity = turnIdentity(turn)
    if (identities.has(identity)) return merged
    identities.add(identity)
    return appendReviewTurn(merged, turn)
  }, current)
}

const turnIdentity = (
  turn: (typeof RelayReviewConversationTurns.Type)[number]
): string => turn.id ?? JSON.stringify(turn)

const compatibleReplacementTurns = (
  current: StoredRelayReviewSession,
  incoming: RelayReviewSessionWrite
): typeof RelayReviewConversationTurns.Type => {
  const currentTurns = reconcileReviewConversationTurns(current.review, incoming.review, current.turns)
  const incomingTurns = reconcileReviewConversationTurns(incoming.review, current.review, incoming.turns)
  return mergeTurns(currentTurns, incomingTurns)
}

const compatibleStaleIncomingTurns = (
  current: StoredRelayReviewSession,
  incoming: RelayReviewSessionWrite
): typeof RelayReviewConversationTurns.Type => {
  const compatible = reconcileReviewConversationTurns(incoming.review, current.review, incoming.turns)
  const currentTurnIds = new Set(current.turns.map(turnIdentity))
  const incomingTurnIds = new Set(incoming.turns.map(turnIdentity))
  const currentTail = current.turns.at(-1)
  const incomingTail = incoming.turns.at(-1)
  const hasOverlap = incoming.turns.some((turn) => currentTurnIds.has(turnIdentity(turn)))
  const incomingTailIsCurrent = incomingTail !== undefined && currentTurnIds.has(turnIdentity(incomingTail))
  const currentTailIsIncoming = currentTail !== undefined && incomingTurnIds.has(turnIdentity(currentTail))
  const isOlderWindow = hasOverlap && incomingTailIsCurrent && !currentTailIsIncoming
  if (
    !hasOverlap &&
    incoming.turns.length >= MAXIMUM_RELAY_REVIEW_TURNS &&
    current.turns.length >= MAXIMUM_RELAY_REVIEW_TURNS
  ) {
    const appendedTurnIds = new Set(incoming.appendedTurnIds ?? [])
    const appendedTurns = incoming.turns.filter((turn) => appendedTurnIds.has(turnIdentity(turn)))
    return appendedTurns.reduce(
      (turns, turn) => appendReviewTurn(turns, turn),
      current.turns
    )
  }
  return isOlderWindow ? compatible.filter(({ findingId }) => findingId === "PR") : compatible
}

const compatibleIncomingDispositions = (
  current: StoredRelayReviewSession,
  incoming: RelayReviewSessionWrite
): FindingDispositions => {
  const currentFindings = new Map(
    current.review.result.findings.map((finding): [string, string] => [finding.id, JSON.stringify(finding)])
  )
  const incomingFindings = new Map(
    incoming.review.result.findings.map((finding): [string, string] => [finding.id, JSON.stringify(finding)])
  )
  return Object.entries(incoming.dispositions).reduce<FindingDispositions>((compatible, [findingId, disposition]) => {
    const currentSnapshot = currentFindings.get(findingId)
    const incomingSnapshot = incomingFindings.get(findingId)
    return currentSnapshot !== undefined && currentSnapshot === incomingSnapshot
      ? { ...compatible, [findingId]: disposition }
      : compatible
  }, {})
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
  const observedCurrentVersion = incoming.expectedVersion === current.version
  if (!observedCurrentVersion) {
    const dispositions = mergeDispositions(current.dispositions, compatibleIncomingDispositions(current, incoming))
    return {
      _tag: "stale-review-preserved",
      session: {
        ...current,
        dispositions,
        turns: mergeTurns(current.turns, compatibleStaleIncomingTurns(current, incoming)),
        version: current.version + 1
      }
    }
  }
  const sameHead = current.identity === incoming.identity
  const expectedHead = current.identity === incoming.expectedIdentity
  if (sameHead) {
    return {
      _tag: "stored",
      session: storedSession(incoming, compatibleReplacementTurns(current, incoming), current.version + 1)
    }
  }
  if (expectedHead) {
    return {
      _tag: "stored",
      session: storedSession(incoming, compatibleReplacementTurns(current, incoming), current.version + 1)
    }
  }
  const dispositions = mergeDispositions(current.dispositions, compatibleIncomingDispositions(current, incoming))
  return {
    _tag: "stale-review-preserved",
    session: {
      ...current,
      dispositions,
      turns: mergeTurns(current.turns, compatibleStaleIncomingTurns(current, incoming)),
      version: current.version + 1
    }
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

export const writeRelayReviewSession = async (
  storage: RelayReviewSessionReadableStorage & RelayReviewSessionWritableStorage,
  key: string,
  session: RelayReviewSessionWrite,
  lock: RelayReviewSessionLock
): Promise<Result.Result<RelayReviewSessionWriteOutcome, RelayReviewSessionReadFailure>> => {
  try {
    return await lock.request(`codecommit:relay-review-session:${key}`, async () => {
      const existing = readRelayReviewSession(storage, key, session.resource)
      if (Result.isFailure(existing)) return Result.fail(existing.failure)
      const outcome: RelayReviewSessionWriteOutcome = existing.success === null
        ? { _tag: "stored", session: storedSession(session, session.turns, 1) }
        : mergeStoredSession(existing.success, session)
      const encoded = JSON.stringify(outcome.session)
      const written = Result.try({
        try: () => {
          storage.setItem(key, encoded)
        },
        catch: () => new RelayReviewSessionStorageUnavailable({ operation: "write" })
      })
      if (Result.isFailure(written)) return Result.fail(written.failure)
      const persisted = Result.try({
        try: () => storage.getItem(key),
        catch: () => new RelayReviewSessionStorageUnavailable({ operation: "write" })
      })
      if (Result.isFailure(persisted)) return Result.fail(persisted.failure)
      return persisted.success === encoded
        ? Result.succeed(outcome)
        : Result.fail(new RelayReviewSessionStorageUnavailable({ operation: "write" }))
    })
  } catch {
    return Result.fail(new RelayReviewSessionStorageUnavailable({ operation: "write" }))
  }
}

/** Move a validated session when provider enrichment replaces the credential identity with the repository identity. */
export const migrateRelayReviewSession = async (
  storage: RelayReviewSessionReadableStorage & RelayReviewSessionWritableStorage,
  sourceKey: string,
  sourceResource: RelayReviewSessionResourceIdentity,
  targetKey: string,
  targetResource: RelayReviewSessionResourceIdentity,
  targetIdentity: string,
  lock: RelayReviewSessionLock
): Promise<Result.Result<StoredRelayReviewSession | null, RelayReviewSessionReadFailure>> => {
  const source = readRelayReviewSession(storage, sourceKey, sourceResource)
  if (Result.isFailure(source) || source.success === null) return source
  const migrated = await writeRelayReviewSession(storage, targetKey, {
    dispositions: source.success.dispositions,
    expectedIdentity: targetIdentity,
    expectedVersion: 0,
    identity: targetIdentity,
    resource: targetResource,
    review: source.success.review,
    skillIds: source.success.skillIds,
    turns: source.success.turns
  }, lock)
  return Result.isFailure(migrated) ? Result.fail(migrated.failure) : Result.succeed(migrated.success.session)
}
