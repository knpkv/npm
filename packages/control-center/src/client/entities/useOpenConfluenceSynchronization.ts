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
  const active = useRef<ActiveSynchronization | null>(null)
  const sessionExpired = useRef(onSessionExpired)
  const synchronized = useRef(onSynchronized)
  sessionExpired.current = onSessionExpired
  synchronized.current = onSynchronized

  const synchronize = useCallback((): Promise<void> => {
    if (!enabled || pluginConnectionId === null || sessionKey === null) return Promise.resolve()
    const inFlight = active.current
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
      if (active.current?.abort === abort) active.current = null
    })
    active.current = { abort, completion }
    return completion
  }, [enabled, pluginConnectionId, sessionKey, transport])

  const synchronizeAfterMutation = useCallback((): void => {
    const inFlight = active.current?.completion
    if (inFlight === undefined) void synchronize()
    else void inFlight.then(synchronize)
  }, [synchronize])

  useEffect(() => {
    setState("idle")
    if (!enabled || pluginConnectionId === null || sessionKey === null) return
    const lifetime = new AbortController()
    const run = async (): Promise<void> => {
      if (document.visibilityState === "visible") await synchronize()
      while (!lifetime.signal.aborted) {
        try {
          await Effect.runPromise(Effect.sleep(OPEN_CONFLUENCE_SYNC_INTERVAL), { signal: lifetime.signal })
        } catch {
          return
        }
        if (document.visibilityState === "visible") await synchronize()
      }
    }
    const synchronizeWhenVisible = (): void => {
      if (document.visibilityState === "visible") void synchronize()
    }
    document.addEventListener("visibilitychange", synchronizeWhenVisible)
    void run()
    return () => {
      lifetime.abort()
      active.current?.abort.abort()
      active.current = null
      document.removeEventListener("visibilitychange", synchronizeWhenVisible)
    }
  }, [enabled, pluginConnectionId, sessionKey, synchronize])

  return {
    state,
    synchronizeAfterMutation,
    synchronizeNow: () => void synchronize()
  }
}
