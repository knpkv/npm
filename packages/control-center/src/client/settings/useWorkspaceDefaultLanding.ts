import * as Predicate from "effect/Predicate"
import { useEffect, useState } from "react"

import type { WorkspaceId } from "../../domain/identifiers.js"
import type { WorkspaceSettingsV1 } from "../../domain/workspaceSettings.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { releaseParentPath, workspaceActiveWorkPath } from "../releases/releaseRoutes.js"
import { subscribeWorkspaceSettings } from "./workspaceSettingsSignals.js"
import type { WorkspaceSettingsTransport } from "./workspaceSettingsTransport.js"

const isUnauthorized = Predicate.isTagged("UnauthorizedApiError")

/** Resolve the configured home destination without redirecting deep links. */
export const workspaceDefaultLandingPath = (
  workspaceId: WorkspaceId,
  defaultLanding: WorkspaceSettingsV1["presentation"]["defaultLanding"]
): string =>
  defaultLanding === "active-work"
    ? workspaceActiveWorkPath(workspaceId)
    : releaseParentPath(workspaceId)

interface LoadedLanding {
  readonly path: string
  readonly revision: number
  readonly sessionKey: string
  readonly workspaceId: WorkspaceId
}

const lazyBrowserWorkspaceSettingsTransport: Pick<WorkspaceSettingsTransport, "load"> = {
  load: async (signal) => {
    const { browserWorkspaceSettingsTransport } = await import("./workspaceSettingsTransport.js")
    return browserWorkspaceSettingsTransport.load(signal)
  }
}

/** Read one workspace's server-owned home destination for brand and root navigation. */
export const useWorkspaceDefaultLandingPath = (
  workspaceId: WorkspaceId | null,
  transport: Pick<WorkspaceSettingsTransport, "load"> = lazyBrowserWorkspaceSettingsTransport
): string | null => {
  const { invalidateSession, state: browserSession } = useBrowserSession()
  const sessionKey = browserReadableSessionKey(browserSession)
  const [loaded, setLoaded] = useState<LoadedLanding | null>(null)

  useEffect(() =>
    subscribeWorkspaceSettings((settings) => {
      if (
        workspaceId === null ||
        sessionKey === null ||
        settings.workspaceId !== workspaceId
      ) return
      setLoaded((current) => {
        if (
          current?.sessionKey === sessionKey &&
          current.workspaceId === workspaceId &&
          current.revision > settings.revision
        ) return current
        return {
          path: workspaceDefaultLandingPath(
            workspaceId,
            settings.settings.presentation.defaultLanding
          ),
          revision: settings.revision,
          sessionKey,
          workspaceId
        }
      })
    }), [sessionKey, workspaceId])

  useEffect(() => {
    if (workspaceId === null || sessionKey === null) {
      setLoaded(null)
      return
    }
    const request = new AbortController()
    transport.load(request.signal).then(
      (settings) => {
        if (request.signal.aborted || settings.workspaceId !== workspaceId) return
        setLoaded((current) => {
          if (
            current?.sessionKey === sessionKey &&
            current.workspaceId === workspaceId &&
            current.revision > settings.revision
          ) return current
          return {
            path: workspaceDefaultLandingPath(
              workspaceId,
              settings.settings.presentation.defaultLanding
            ),
            revision: settings.revision,
            sessionKey,
            workspaceId
          }
        })
      },
      (failure) => {
        if (request.signal.aborted) return
        if (isUnauthorized(failure)) invalidateSession(sessionKey)
        setLoaded((current) => {
          if (
            current?.sessionKey === sessionKey &&
            current.workspaceId === workspaceId
          ) return current
          return {
            path: releaseParentPath(workspaceId),
            revision: 0,
            sessionKey,
            workspaceId
          }
        })
      }
    )
    return () => request.abort()
  }, [invalidateSession, sessionKey, transport, workspaceId])

  return loaded?.sessionKey === sessionKey && loaded.workspaceId === workspaceId
    ? loaded.path
    : null
}
