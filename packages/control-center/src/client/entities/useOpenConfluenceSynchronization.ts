import * as Clock from "effect/Clock"
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
  readonly onSessionExpired: () => void
  readonly onSynchronized: () => void
  readonly setState: (state: OpenConfluenceSynchronizationState) => void
  readonly transport: OpenConfluenceSynchronizationTransport
}

interface AutomaticSynchronizationGroup {
  active: ActiveSynchronization | null
  readonly participants: Map<symbol, AutomaticSynchronizationParticipant>
}

const CrossTabAutomaticSynchronization = Schema.Struct({
  recordedAt: Schema.Number,
  sessionExpired: Schema.Boolean,
  state: Schema.Literals(["syncing", "synchronized", "failed"])
})

type CrossTabAutomaticSynchronization = typeof CrossTabAutomaticSynchronization.Type

const automaticSynchronizationGroups = new Map<PluginConnectionId, AutomaticSynchronizationGroup>()
const automaticSynchronizationCleanup = new WeakMap<AutomaticSynchronizationGroup, () => void>()

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

const applyAutomaticSynchronization = (
  group: AutomaticSynchronizationGroup,
  synchronization: CrossTabAutomaticSynchronization
): void => {
  for (const participant of group.participants.values()) {
    participant.setState(synchronization.state)
    if (synchronization.sessionExpired) participant.onSessionExpired()
    if (synchronization.state === "synchronized") participant.onSynchronized()
  }
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
  const synchronizeWithLease = async (): Promise<void> => {
    const requestStartedAt = await requestedAt
    const recordedAt = await Effect.runPromise(Clock.currentTimeMillis)
    const recent = readCrossTabSynchronization(storageKey)
    if (
      recent !== null &&
      (recent.recordedAt >= requestStartedAt ||
        (!force && recordedAt - recent.recordedAt < OPEN_CONFLUENCE_SYNC_INTERVAL_MILLIS))
    ) {
      if (recent.state !== "syncing") applyAutomaticSynchronization(group, recent)
      return
    }
    const source = group.participants.values().next().value
    if (source === undefined || abort.signal.aborted) return
    const syncing = { recordedAt, sessionExpired: false, state: "syncing" } satisfies CrossTabAutomaticSynchronization
    writeCrossTabSynchronization(storageKey, syncing)
    applyAutomaticSynchronization(group, syncing)
    try {
      const result = await source.transport.synchronize(pluginConnectionId, abort.signal)
      if (abort.signal.aborted) return
      const completed = {
        recordedAt: await Effect.runPromise(Clock.currentTimeMillis),
        sessionExpired: false,
        state: result.result === "synchronized" ? "synchronized" : "failed"
      } satisfies CrossTabAutomaticSynchronization
      writeCrossTabSynchronization(storageKey, completed)
      applyAutomaticSynchronization(group, completed)
    } catch (failure) {
      if (abort.signal.aborted) return
      const failed = {
        recordedAt: await Effect.runPromise(Clock.currentTimeMillis),
        sessionExpired: Predicate.isTagged("UnauthorizedApiError")(failure),
        state: "failed"
      } satisfies CrossTabAutomaticSynchronization
      writeCrossTabSynchronization(storageKey, failed)
      applyAutomaticSynchronization(group, failed)
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
  ).catch((failure: unknown) => {
    if (!abort.signal.aborted) {
      const failed = {
        recordedAt: 0,
        sessionExpired: Predicate.isTagged("UnauthorizedApiError")(failure),
        state: "failed"
      } satisfies CrossTabAutomaticSynchronization
      applyAutomaticSynchronization(group, failed)
    }
  }).finally(() => {
    if (group.active?.abort === abort) group.active = null
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
    if (synchronization !== null) applyAutomaticSynchronization(group, synchronization)
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

/** Keep an open Confluence page fresh without polling while its browser tab is hidden. */
export const useOpenConfluenceSynchronization = ({
  enabled,
  onSessionExpired,
  onSynchronized,
  pluginConnectionId,
  sessionKey,
  transport = browserOpenConfluenceSynchronizationTransport
}: {
  readonly enabled: boolean
  readonly onSessionExpired: (sessionKey: string) => void
  readonly onSynchronized: () => void
  readonly pluginConnectionId: PluginConnectionId | null
  readonly sessionKey: string | null
  readonly transport?: OpenConfluenceSynchronizationTransport
}): {
  readonly state: OpenConfluenceSynchronizationState
  readonly synchronizeAfterMutation: () => void
  readonly synchronizeNow: () => void
} => {
  const [state, setState] = useState<OpenConfluenceSynchronizationState>("idle")
  const manualActive = useRef<ActiveSynchronization | null>(null)
  const sessionExpired = useRef(onSessionExpired)
  const synchronized = useRef(onSynchronized)
  sessionExpired.current = onSessionExpired
  synchronized.current = onSynchronized

  const synchronize = useCallback((): Promise<void> => {
    if (!enabled || pluginConnectionId === null || sessionKey === null) return Promise.resolve()
    const inFlight = manualActive.current
    if (inFlight !== null) return inFlight.completion
    const abort = new AbortController()
    setState("syncing")
    const completion = transport.synchronize(pluginConnectionId, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return
        if (result.result !== "synchronized") {
          setState("failed")
          return
        }
        setState("synchronized")
        synchronized.current()
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) sessionExpired.current(sessionKey)
        setState("failed")
      }
    ).finally(() => {
      if (manualActive.current?.abort === abort) manualActive.current = null
    })
    manualActive.current = { abort, completion }
    return completion
  }, [enabled, pluginConnectionId, sessionKey, transport])

  const synchronizeAfterMutation = useCallback((): void => {
    const automaticInFlight = pluginConnectionId === null
      ? undefined
      : automaticSynchronizationGroups.get(pluginConnectionId)?.active?.completion
    const inFlight = manualActive.current?.completion ?? automaticInFlight
    if (inFlight === undefined) void synchronize()
    else void inFlight.then(synchronize)
  }, [pluginConnectionId, synchronize])

  useEffect(() => {
    setState("idle")
    if (!enabled || pluginConnectionId === null || sessionKey === null) return
    const unregister = registerAutomaticSynchronization(pluginConnectionId, {
      onSessionExpired: () => sessionExpired.current(sessionKey),
      onSynchronized: () => synchronized.current(),
      setState,
      transport
    })
    return () => {
      unregister()
      manualActive.current?.abort.abort()
      manualActive.current = null
    }
  }, [enabled, pluginConnectionId, sessionKey, transport])

  return {
    state,
    synchronizeAfterMutation,
    synchronizeNow: () => void synchronize()
  }
}
