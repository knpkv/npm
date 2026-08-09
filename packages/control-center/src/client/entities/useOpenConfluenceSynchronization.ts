import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { useCallback, useEffect, useRef, useState } from "react"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import { browserConnectionTestTransport } from "../services/connectionTestTransport.js"

export const OPEN_CONFLUENCE_SYNC_INTERVAL = "15 seconds"

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

const automaticSynchronizationGroups = new Map<PluginConnectionId, AutomaticSynchronizationGroup>()
const automaticSynchronizationCleanup = new WeakMap<AutomaticSynchronizationGroup, () => void>()

const synchronizeAutomatically = (
  pluginConnectionId: PluginConnectionId,
  group: AutomaticSynchronizationGroup
): Promise<void> => {
  if (group.active !== null) return group.active.completion
  const source = group.participants.values().next().value
  if (source === undefined) return Promise.resolve()
  const abort = new AbortController()
  for (const participant of group.participants.values()) participant.setState("syncing")
  const completion = source.transport.synchronize(pluginConnectionId, abort.signal).then(
    (result) => {
      if (abort.signal.aborted) return
      for (const participant of group.participants.values()) {
        if (result.result === "synchronized") {
          participant.setState("synchronized")
          participant.onSynchronized()
        } else participant.setState("failed")
      }
    },
    (failure) => {
      if (abort.signal.aborted) return
      for (const participant of group.participants.values()) {
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) participant.onSessionExpired()
        participant.setState("failed")
      }
    }
  ).finally(() => {
    if (group.active?.abort === abort) group.active = null
  })
  group.active = { abort, completion }
  return completion
}

const startAutomaticSynchronization = (
  pluginConnectionId: PluginConnectionId,
  group: AutomaticSynchronizationGroup
): () => void => {
  const lifetime = new AbortController()
  const run = async (): Promise<void> => {
    if (document.visibilityState === "visible") await synchronizeAutomatically(pluginConnectionId, group)
    while (!lifetime.signal.aborted) {
      try {
        await Effect.runPromise(Effect.sleep(OPEN_CONFLUENCE_SYNC_INTERVAL), { signal: lifetime.signal })
      } catch {
        return
      }
      if (document.visibilityState === "visible") await synchronizeAutomatically(pluginConnectionId, group)
    }
  }
  const synchronizeWhenVisible = (): void => {
    if (document.visibilityState === "visible") void synchronizeAutomatically(pluginConnectionId, group)
  }
  document.addEventListener("visibilitychange", synchronizeWhenVisible)
  void run()
  return () => {
    lifetime.abort()
    group.active?.abort.abort()
    group.active = null
    document.removeEventListener("visibilitychange", synchronizeWhenVisible)
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
    const inFlight = manualActive.current?.completion
    if (inFlight === undefined) void synchronize()
    else void inFlight.then(synchronize)
  }, [synchronize])

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
