import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { ReleaseId } from "../../domain/identifiers.js"

export interface ReleaseWorksetTransport {
  readonly load: (releaseId: ReleaseId, signal: AbortSignal) => Promise<ReleaseDeliveryGraphInspection>
}

export type ReleaseWorksetState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly releaseId: ReleaseId; readonly sessionKey: string }
  | { readonly _tag: "failed"; readonly releaseId: ReleaseId; readonly sessionKey: string }
  | {
    readonly _tag: "ready"
    readonly inspection: ReleaseDeliveryGraphInspection
    readonly releaseId: ReleaseId
    readonly sessionKey: string
  }

/** Generated-client transport for one authenticated bounded release graph. */
export const browserReleaseWorksetTransport: ReleaseWorksetTransport = {
  load: (releaseId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.releaseSlice({
          params: { releaseId },
          query: {}
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep one release workset scoped to the exact authenticated browser session. */
export const useReleaseWorkset = (
  releaseId: ReleaseId,
  sessionKey: string | null,
  transport: ReleaseWorksetTransport = browserReleaseWorksetTransport
): { readonly retry: () => void; readonly state: ReleaseWorksetState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<ReleaseWorksetState>({ _tag: "idle" })

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", releaseId, sessionKey })
    transport.load(releaseId, abort.signal).then(
      (inspection) => {
        if (!abort.signal.aborted) setState({ _tag: "ready", inspection, releaseId, sessionKey })
      },
      () => {
        if (!abort.signal.aborted) setState({ _tag: "failed", releaseId, sessionKey })
      }
    )
    return () => abort.abort()
  }, [releaseId, requestRevision, sessionKey, transport])

  const currentState: ReleaseWorksetState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.releaseId !== releaseId || state.sessionKey !== sessionKey
    ? { _tag: "loading", releaseId, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
