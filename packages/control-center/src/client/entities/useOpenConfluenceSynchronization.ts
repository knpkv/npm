import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { useCallback, useEffect, useRef, useState } from "react"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import { browserConnectionTestTransport } from "../services/connectionTestTransport.js"

export const OPEN_CONFLUENCE_SYNC_INTERVAL = "15 seconds"
const OPEN_CONFLUENCE_SYNC_INTERVAL_MILLIS = 15_000
const OPEN_CONFLUENCE_SYNC_MAX_FORWARD_SKEW_MILLIS = 1_000
const OPEN_CONFLUENCE_SYNC_LEASE_MILLIS = 15 * 60_000

export type OpenConfluenceSynchronizationState = "idle" | "syncing" | "synchronized" | "failed"

export interface OpenConfluenceSynchronizationTransport {
  readonly synchronize: (
    pluginConnectionId: PluginConnectionId,
    signal: AbortSignal
  ) => Promise<PluginSynchronizationState>
}

interface ActiveSynchronization {
  readonly abort: AbortController
  readonly completion: Promise<void>
}

const browserOpenConfluenceSynchronizationTransport: OpenConfluenceSynchronizationTransport = {
  synchronize: (pluginConnectionId, signal) => {
    const synchronize = browserConnectionTestTransport.synchronize
    return synchronize === undefined
      ? Promise.reject(new Error("Confluence synchronization is unavailable"))
      : synchronize(pluginConnectionId, signal)
  }
}

interface AutomaticSynchronizationParticipant {
  readonly lifetime: AbortSignal
  readonly onSessionExpired: () => void
  readonly onSynchronized: () => void
  readonly ownerKey: string
  readonly sessionKey: string
  readonly setState: (state: OpenConfluenceSynchronizationState) => void
  readonly transport: OpenConfluenceSynchronizationTransport
  readonly verifySynchronized: (signal: AbortSignal) => Promise<boolean>
}

interface AutomaticSynchronizationGroup {
  active: ActiveSynchronization | null
  readonly participants: Map<symbol, AutomaticSynchronizationParticipant>
}

const CrossTabAutomaticSynchronization = Schema.Struct({
  ownerKey: Schema.String,
  recordedAt: Schema.Number,
  sessionExpired: Schema.Boolean,
  state: Schema.Literals(["syncing", "synchronized", "failed"])
})

type CrossTabAutomaticSynchronization = typeof CrossTabAutomaticSynchronization.Type

const automaticSynchronizationGroups = new Map<PluginConnectionId, AutomaticSynchronizationGroup>()
const automaticSynchronizationCleanup = new WeakMap<AutomaticSynchronizationGroup, () => void>()
const automaticSynchronizationOwnerKeys = new Map<string, string>()
const makeAutomaticSynchronizationOwnerKey = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  return yield* cryptoService.randomUUIDv4
}).pipe(Effect.provide(BrowserCrypto.layer))

const automaticSynchronizationOwnerKey = (sessionKey: string): string => {
  const existing = automaticSynchronizationOwnerKeys.get(sessionKey)
  if (existing !== undefined) return existing
  const ownerKey = Effect.runSync(makeAutomaticSynchronizationOwnerKey)
  automaticSynchronizationOwnerKeys.set(sessionKey, ownerKey)
  return ownerKey
}

const automaticSynchronizationStorageKey = (pluginConnectionId: PluginConnectionId): string =>
  `control-center:confluence-sync:${pluginConnectionId}`

const readCrossTabSynchronization = (key: string): CrossTabAutomaticSynchronization | null => {
  try {
    const value = localStorage.getItem(key)
    if (value === null) return null
    return Result.getOrNull(
      Schema.decodeUnknownResult(Schema.fromJsonString(CrossTabAutomaticSynchronization))(value)
    )
  } catch {
    return null
  }
}

const writeCrossTabSynchronization = (
  key: string,
  synchronization: CrossTabAutomaticSynchronization
): void => {
  try {
    localStorage.setItem(
      key,
      Schema.encodeSync(Schema.fromJsonString(CrossTabAutomaticSynchronization))(synchronization)
    )
  } catch {
    // Storage can be unavailable in a restricted browser context; the in-document coordinator remains active.
  }
}

const clearCrossTabSynchronization = (
  key: string,
  expected: CrossTabAutomaticSynchronization
): void => {
  const current = readCrossTabSynchronization(key)
  if (
    current?.state !== "syncing" ||
    current.ownerKey !== expected.ownerKey ||
    current.recordedAt !== expected.recordedAt
  ) return
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in a restricted browser context; the in-document coordinator remains active.
  }
}

const applyAutomaticSynchronization = async (
  group: AutomaticSynchronizationGroup,
  synchronization: CrossTabAutomaticSynchronization
): Promise<boolean> => {
  let requiresSessionRetry = false
  await Promise.all(Array.from(group.participants.values(), async (participant) => {
    if (participant.lifetime.aborted) return
    if (synchronization.sessionExpired && synchronization.ownerKey !== participant.ownerKey) {
      requiresSessionRetry = true
      return
    }
    if (synchronization.state !== "synchronized") {
      participant.setState(synchronization.state)
      if (synchronization.sessionExpired) participant.onSessionExpired()
      return
    }
    participant.setState("syncing")
    try {
      const verified = await participant.verifySynchronized(participant.lifetime)
      if (participant.lifetime.aborted) return
      participant.setState(verified ? "synchronized" : "idle")
      if (verified) participant.onSynchronized()
    } catch (failure) {
      if (participant.lifetime.aborted) return
      if (Predicate.isTagged("UnauthorizedApiError")(failure)) participant.onSessionExpired()
      participant.setState("failed")
    }
  }))
  return requiresSessionRetry
}

const synchronizeAutomatically = (
  pluginConnectionId: PluginConnectionId,
  group: AutomaticSynchronizationGroup,
  force = false
): Promise<void> => {
  if (group.active !== null) return group.active.completion
  const abort = new AbortController()
  const requestedAt = Effect.runPromise(Clock.currentTimeMillis)
  const storageKey = automaticSynchronizationStorageKey(pluginConnectionId)
  let retryAfterCompletion = false
  const synchronizeWithLease = async (): Promise<void> => {
    const requestStartedAt = await requestedAt
    const recordedAt = await Effect.runPromise(Clock.currentTimeMillis)
    const source = group.participants.values().next().value
    if (source === undefined || abort.signal.aborted) return
    const recent = readCrossTabSynchronization(storageKey)
    const recentAge = recent === null ? null : recordedAt - recent.recordedAt
    if (
      recent !== null &&
      recentAge !== null &&
      recent.recordedAt <= recordedAt + OPEN_CONFLUENCE_SYNC_MAX_FORWARD_SKEW_MILLIS &&
      (!recent.sessionExpired || recent.ownerKey === source.ownerKey) &&
      (recent.state === "syncing"
        ? recentAge < OPEN_CONFLUENCE_SYNC_LEASE_MILLIS
        : !force &&
          (recent.recordedAt >= requestStartedAt || recentAge < OPEN_CONFLUENCE_SYNC_INTERVAL_MILLIS))
    ) {
      if (recent.state !== "syncing") retryAfterCompletion = await applyAutomaticSynchronization(group, recent)
      return
    }
    const syncing = {
      ownerKey: source.ownerKey,
      recordedAt,
      sessionExpired: false,
      state: "syncing"
    } satisfies CrossTabAutomaticSynchronization
    writeCrossTabSynchronization(storageKey, syncing)
    retryAfterCompletion = await applyAutomaticSynchronization(group, syncing)
    const releaseSyncingRecord = (): void => clearCrossTabSynchronization(storageKey, syncing)
    abort.signal.addEventListener("abort", releaseSyncingRecord, { once: true })
    try {
      const result = await source.transport.synchronize(pluginConnectionId, abort.signal)
      if (abort.signal.aborted) return releaseSyncingRecord()
      const completed = {
        ownerKey: source.ownerKey,
        recordedAt: await Effect.runPromise(Clock.currentTimeMillis),
        sessionExpired: false,
        state: result.result === "synchronized" ? "synchronized" : "failed"
      } satisfies CrossTabAutomaticSynchronization
      writeCrossTabSynchronization(storageKey, completed)
      retryAfterCompletion = await applyAutomaticSynchronization(group, completed)
    } catch (failure) {
      if (abort.signal.aborted) return releaseSyncingRecord()
      const failed = {
        ownerKey: source.ownerKey,
        recordedAt: await Effect.runPromise(Clock.currentTimeMillis),
        sessionExpired: Predicate.isTagged("UnauthorizedApiError")(failure),
        state: "failed"
      } satisfies CrossTabAutomaticSynchronization
      writeCrossTabSynchronization(storageKey, failed)
      retryAfterCompletion = await applyAutomaticSynchronization(group, failed)
    } finally {
      abort.signal.removeEventListener("abort", releaseSyncingRecord)
    }
  }
  const lockManager = "locks" in navigator ? navigator.locks : null
  const completion = (
    lockManager === null
      ? synchronizeWithLease()
      : lockManager.request(
        `control-center:confluence-sync:${pluginConnectionId}`,
        { ifAvailable: true },
        (lock) => lock === null ? Promise.resolve() : synchronizeWithLease()
      )
  ).catch(async (failure: unknown) => {
    const source = group.participants.values().next().value
    if (!abort.signal.aborted && source !== undefined) {
      const failed = {
        ownerKey: source.ownerKey,
        recordedAt: 0,
        sessionExpired: Predicate.isTagged("UnauthorizedApiError")(failure),
        state: "failed"
      } satisfies CrossTabAutomaticSynchronization
      retryAfterCompletion = await applyAutomaticSynchronization(group, failed)
    }
  }).finally(() => {
    if (group.active?.abort === abort) group.active = null
    if (retryAfterCompletion && document.visibilityState === "visible") {
      void synchronizeAutomatically(pluginConnectionId, group, true)
    }
  })
  group.active = { abort, completion }
  return completion
}

const startAutomaticSynchronization = (
  pluginConnectionId: PluginConnectionId,
  group: AutomaticSynchronizationGroup
): () => void => {
  let cadence: AbortController | null = null
  let generation = 0
  let stopped = false
  const schedule = (currentGeneration: number): void => {
    if (stopped || currentGeneration !== generation) return
    const nextCadence = new AbortController()
    cadence = nextCadence
    void Effect.runPromise(Effect.sleep(OPEN_CONFLUENCE_SYNC_INTERVAL), { signal: nextCadence.signal }).then(
      () => synchronizeAndSchedule(),
      (_failure: unknown) => {
        if (!nextCadence.signal.aborted) {
          for (const participant of group.participants.values()) participant.setState("failed")
        }
      }
    )
  }
  const synchronizeAndSchedule = (): void => {
    generation += 1
    const currentGeneration = generation
    cadence?.abort()
    cadence = null
    const completion = document.visibilityState === "visible"
      ? synchronizeAutomatically(pluginConnectionId, group)
      : Promise.resolve()
    void completion.finally(() => schedule(currentGeneration))
  }
  const synchronizeWhenVisible = (): void => {
    if (document.visibilityState === "visible") {
      generation += 1
      const currentGeneration = generation
      cadence?.abort()
      cadence = null
      void synchronizeAutomatically(pluginConnectionId, group, true).finally(() => schedule(currentGeneration))
    }
  }
  const synchronizeFromAnotherTab = (event: StorageEvent): void => {
    if (event.key !== automaticSynchronizationStorageKey(pluginConnectionId) || event.newValue === null) return
    const synchronization = Result.getOrNull(
      Schema.decodeUnknownResult(Schema.fromJsonString(CrossTabAutomaticSynchronization))(event.newValue)
    )
    if (synchronization === null) return
    void applyAutomaticSynchronization(group, synchronization).then((requiresSessionRetry) => {
      if (requiresSessionRetry && document.visibilityState === "visible") {
        void synchronizeAutomatically(pluginConnectionId, group, true)
      }
    })
  }
  document.addEventListener("visibilitychange", synchronizeWhenVisible)
  window.addEventListener("storage", synchronizeFromAnotherTab)
  synchronizeAndSchedule()
  return () => {
    stopped = true
    generation += 1
    cadence?.abort()
    cadence = null
    group.active?.abort.abort()
    group.active = null
    document.removeEventListener("visibilitychange", synchronizeWhenVisible)
    window.removeEventListener("storage", synchronizeFromAnotherTab)
  }
}

const registerAutomaticSynchronization = (
  pluginConnectionId: PluginConnectionId,
  participant: AutomaticSynchronizationParticipant
): () => void => {
  const participantId = Symbol()
  const existing = automaticSynchronizationGroups.get(pluginConnectionId)
  const group = existing ?? { active: null, participants: new Map() }
  group.participants.set(participantId, participant)
  if (existing === undefined) {
    automaticSynchronizationGroups.set(pluginConnectionId, group)
    automaticSynchronizationCleanup.set(group, startAutomaticSynchronization(pluginConnectionId, group))
  }
  return () => {
    group.participants.delete(participantId)
    if (group.participants.size !== 0) return
    automaticSynchronizationCleanup.get(group)?.()
    automaticSynchronizationCleanup.delete(group)
    if (automaticSynchronizationGroups.get(pluginConnectionId) === group) {
      automaticSynchronizationGroups.delete(pluginConnectionId)
    }
  }
}

const activeCrossTabSynchronizationLease = async (
  storageKey: string
): Promise<{ readonly remainingMillis: number; readonly synchronization: CrossTabAutomaticSynchronization } | null> => {
  const synchronization = readCrossTabSynchronization(storageKey)
  if (synchronization?.state !== "syncing") return null
  const now = await Effect.runPromise(Clock.currentTimeMillis)
  if (synchronization.recordedAt > now + OPEN_CONFLUENCE_SYNC_MAX_FORWARD_SKEW_MILLIS) return null
  const remainingMillis = synchronization.recordedAt + OPEN_CONFLUENCE_SYNC_LEASE_MILLIS - now
  return remainingMillis <= 0 ? null : { remainingMillis, synchronization }
}

const waitForCrossTabSynchronization = async (pluginConnectionId: PluginConnectionId): Promise<void> => {
  const storageKey = automaticSynchronizationStorageKey(pluginConnectionId)
  while (true) {
    const lease = await activeCrossTabSynchronizationLease(storageKey)
    if (lease === null) return
    const lifetime = new AbortController()
    await new Promise<void>((resolve) => {
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        lifetime.abort()
        window.removeEventListener("storage", storageChanged)
        resolve()
      }
      const storageChanged = (event: StorageEvent): void => {
        if (event.key === storageKey) finish()
      }
      window.addEventListener("storage", storageChanged)
      const current = readCrossTabSynchronization(storageKey)
      if (
        current?.state !== "syncing" ||
        current.ownerKey !== lease.synchronization.ownerKey ||
        current.recordedAt !== lease.synchronization.recordedAt
      ) finish()
      void Effect.runPromise(Effect.sleep(lease.remainingMillis), { signal: lifetime.signal }).then(
        finish,
        (_failure: unknown) => {
          if (!lifetime.signal.aborted) finish()
        }
      )
    })
  }
}

/** Keep an open Confluence page fresh without polling while its browser tab is hidden. */
export const useOpenConfluenceSynchronization = ({
  enabled,
  onSessionExpired,
  onSynchronized,
  pluginConnectionId,
  readSynchronizationRevision,
  sessionKey,
  synchronizationRevision,
  transport = browserOpenConfluenceSynchronizationTransport
}: {
  readonly enabled: boolean
  readonly onSessionExpired: (sessionKey: string) => void
  readonly onSynchronized: () => void
  readonly pluginConnectionId: PluginConnectionId | null
  readonly readSynchronizationRevision: (signal: AbortSignal) => Promise<number | null>
  readonly sessionKey: string | null
  readonly synchronizationRevision: number | null
  readonly transport?: OpenConfluenceSynchronizationTransport
}): {
  readonly state: OpenConfluenceSynchronizationState
  readonly synchronizeAfterMutation: () => void
  readonly synchronizeNow: () => void
} => {
  const [state, setState] = useState<OpenConfluenceSynchronizationState>("idle")
  const registrationLifetime = useRef<AbortController | null>(null)
  const sessionExpired = useRef(onSessionExpired)
  const synchronized = useRef(onSynchronized)
  const revisionReader = useRef(readSynchronizationRevision)
  const knownRevision = useRef({ pluginConnectionId, sessionKey, value: synchronizationRevision })
  sessionExpired.current = onSessionExpired
  synchronized.current = onSynchronized
  revisionReader.current = readSynchronizationRevision
  if (
    knownRevision.current.pluginConnectionId !== pluginConnectionId ||
    knownRevision.current.sessionKey !== sessionKey
  ) {
    knownRevision.current = { pluginConnectionId, sessionKey, value: synchronizationRevision }
  } else if (
    synchronizationRevision !== null &&
    (knownRevision.current.value === null || synchronizationRevision > knownRevision.current.value)
  ) {
    knownRevision.current.value = synchronizationRevision
  }
  const verifySynchronized = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const currentRevision = await revisionReader.current(signal)
    const previousRevision = knownRevision.current.value
    if (currentRevision === null || previousRevision === null || currentRevision <= previousRevision) return false
    knownRevision.current.value = currentRevision
    return true
  }, [])

  const synchronize = useCallback((): Promise<void> => {
    if (!enabled || pluginConnectionId === null || sessionKey === null) return Promise.resolve()
    const group = automaticSynchronizationGroups.get(pluginConnectionId)
    return group === undefined ? Promise.resolve() : synchronizeAutomatically(pluginConnectionId, group, true)
  }, [enabled, pluginConnectionId, sessionKey])

  const synchronizeWhenReady = useCallback((): void => {
    const lifetime = registrationLifetime.current?.signal
    if (lifetime === undefined || lifetime.aborted) return
    const inFlight = pluginConnectionId === null
      ? undefined
      : automaticSynchronizationGroups.get(pluginConnectionId)?.active?.completion
        ?? waitForCrossTabSynchronization(pluginConnectionId)
    if (inFlight === undefined) void synchronize()
    else {
      void inFlight.then(() => {
        if (!lifetime.aborted) void synchronize()
      })
    }
  }, [pluginConnectionId, synchronize])

  useEffect(() => {
    setState("idle")
    if (!enabled || pluginConnectionId === null || sessionKey === null) return
    const lifetime = new AbortController()
    registrationLifetime.current = lifetime
    const unregister = registerAutomaticSynchronization(pluginConnectionId, {
      lifetime: lifetime.signal,
      onSessionExpired: () => sessionExpired.current(sessionKey),
      onSynchronized: () => synchronized.current(),
      ownerKey: automaticSynchronizationOwnerKey(sessionKey),
      sessionKey,
      setState,
      transport,
      verifySynchronized
    })
    return () => {
      lifetime.abort()
      if (registrationLifetime.current === lifetime) registrationLifetime.current = null
      unregister()
    }
  }, [enabled, pluginConnectionId, sessionKey, transport, verifySynchronized])

  return {
    state,
    synchronizeAfterMutation: synchronizeWhenReady,
    synchronizeNow: synchronizeWhenReady
  }
}
