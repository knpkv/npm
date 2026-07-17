import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type { ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { presentPortfolio } from "../portfolio/presentPortfolio.js"
import { releaseFullPath } from "../releases/releasePaths.js"

export type CommandReleasePresentation = {
  readonly codename: string
  readonly href: string
  readonly id: ReleaseId
  readonly serviceName: string
  readonly status: string
  readonly tone: "caution" | "critical" | "neutral" | "positive" | "progress"
  readonly version: string
}

export type CommandReleasesState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly sessionKey: string }
  | { readonly _tag: "failed"; readonly sessionKey: string }
  | {
    readonly _tag: "ready"
    readonly releases: ReadonlyArray<CommandReleasePresentation>
    readonly sessionKey: string
    readonly workspaceId: WorkspaceId
  }

export type CommandReleasesTransport = {
  readonly load: (signal: AbortSignal) => Promise<PortfolioSnapshot>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Generated-client transport for one authenticated, bounded portfolio snapshot. */
export const browserCommandReleasesTransport: CommandReleasesTransport = {
  load: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.portfolio.snapshot()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

const presentCommandReleases = (snapshot: PortfolioSnapshot): ReadonlyArray<CommandReleasePresentation> =>
  presentPortfolio(snapshot).releases.map((release) => ({
    codename: release.relay.codename,
    href: releaseFullPath(snapshot.workspaceId, release.id),
    id: release.id,
    serviceName: release.serviceName,
    status: release.lifecycleLabel,
    tone: release.lifecycleTone,
    version: release.version
  }))

/** Load one session-isolated release index while the command surface is open. */
export const useCommandReleases = (
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: CommandReleasesTransport = browserCommandReleasesTransport
): { readonly retry: () => void; readonly state: CommandReleasesState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<CommandReleasesState>({ _tag: "idle" })

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", sessionKey })
    transport.load(abort.signal).then(
      (snapshot) => {
        if (abort.signal.aborted) return
        setState({
          _tag: "ready",
          releases: presentCommandReleases(snapshot),
          sessionKey,
          workspaceId: snapshot.workspaceId
        })
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed", sessionKey })
      }
    )
    return () => abort.abort()
  }, [onSessionExpired, requestRevision, sessionKey, transport])

  const currentState: CommandReleasesState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.sessionKey !== sessionKey
    ? { _tag: "loading", sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
