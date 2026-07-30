import * as Predicate from "effect/Predicate"
import { useCallback, useEffect, useRef, useState } from "react"

import type { WorkspaceSettingsReadModel } from "../../api/workspaceSettings.js"
import type { WorkspaceSettingsMutationId } from "../../domain/identifiers.js"
import {
  changedWorkspaceSettingsSections,
  isGovernedWorkspaceSettingsSection,
  type WorkspaceSettingsV1
} from "../../domain/workspaceSettings.js"
import { publishWorkspaceSettings } from "./workspaceSettingsSignals.js"
import { browserWorkspaceSettingsTransport, type WorkspaceSettingsTransport } from "./workspaceSettingsTransport.js"

export type WorkspaceSettingsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
    readonly _tag: "ready"
    readonly draft: WorkspaceSettingsV1
    readonly pendingMutationId: WorkspaceSettingsMutationId | null
    readonly server: WorkspaceSettingsReadModel
    readonly status: "dirty" | "failed" | "saved" | "saving"
  }
  | {
    readonly _tag: "conflict"
    readonly base: WorkspaceSettingsReadModel
    readonly candidate: WorkspaceSettingsV1
    readonly latest: WorkspaceSettingsReadModel
  }
  | {
    readonly _tag: "conflict-recovery-failed"
    readonly base: WorkspaceSettingsReadModel
    readonly candidate: WorkspaceSettingsV1
  }
  | {
    readonly _tag: "conflict-recovery-loading"
    readonly base: WorkspaceSettingsReadModel
    readonly candidate: WorkspaceSettingsV1
  }

const isConflict = Predicate.isTagged("ConflictApiError")
const isUnauthorized = Predicate.isTagged("UnauthorizedApiError")

const localChangeOrLatest = <Value>(
  base: Value,
  candidate: Value,
  latest: Value,
  equivalent: (left: Value, right: Value) => boolean = Object.is
): Value => equivalent(base, candidate) ? latest : candidate

const stringArraysEqual = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

/** Reapply locally changed fields over a freshly loaded server document. */
export const reapplyWorkspaceSettingsCandidate = (
  base: WorkspaceSettingsV1,
  candidate: WorkspaceSettingsV1,
  latest: WorkspaceSettingsV1
): WorkspaceSettingsV1 => {
  return {
    schemaVersion: 1,
    agent: {
      allowedProviders: localChangeOrLatest(
        base.agent.allowedProviders,
        candidate.agent.allowedProviders,
        latest.agent.allowedProviders,
        stringArraysEqual
      ),
      defaultModel: localChangeOrLatest(
        base.agent.defaultModel,
        candidate.agent.defaultModel,
        latest.agent.defaultModel
      ),
      defaultProvider: localChangeOrLatest(
        base.agent.defaultProvider,
        candidate.agent.defaultProvider,
        latest.agent.defaultProvider
      ),
      profilePolicy: localChangeOrLatest(
        base.agent.profilePolicy,
        candidate.agent.profilePolicy,
        latest.agent.profilePolicy
      ),
      toolPolicy: localChangeOrLatest(
        base.agent.toolPolicy,
        candidate.agent.toolPolicy,
        latest.agent.toolPolicy
      )
    },
    inference: {
      enabled: localChangeOrLatest(
        base.inference.enabled,
        candidate.inference.enabled,
        latest.inference.enabled
      ),
      minimumConfidencePercent: localChangeOrLatest(
        base.inference.minimumConfidencePercent,
        candidate.inference.minimumConfidencePercent,
        latest.inference.minimumConfidencePercent
      )
    },
    investigation: {
      consecutiveFailureThreshold: localChangeOrLatest(
        base.investigation.consecutiveFailureThreshold,
        candidate.investigation.consecutiveFailureThreshold,
        latest.investigation.consecutiveFailureThreshold
      ),
      mode: localChangeOrLatest(
        base.investigation.mode,
        candidate.investigation.mode,
        latest.investigation.mode
      )
    },
    jira: {
      commentMode: localChangeOrLatest(
        base.jira.commentMode,
        candidate.jira.commentMode,
        latest.jira.commentMode
      ),
      includeControlCenterAttribution: localChangeOrLatest(
        base.jira.includeControlCenterAttribution,
        candidate.jira.includeControlCenterAttribution,
        latest.jira.includeControlCenterAttribution
      )
    },
    pipeline: {
      maximumAttempts: localChangeOrLatest(
        base.pipeline.maximumAttempts,
        candidate.pipeline.maximumAttempts,
        latest.pipeline.maximumAttempts
      ),
      retryMode: localChangeOrLatest(
        base.pipeline.retryMode,
        candidate.pipeline.retryMode,
        latest.pipeline.retryMode
      )
    },
    presentation: {
      defaultLanding: localChangeOrLatest(
        base.presentation.defaultLanding,
        candidate.presentation.defaultLanding,
        latest.presentation.defaultLanding
      ),
      density: localChangeOrLatest(
        base.presentation.density,
        candidate.presentation.density,
        latest.presentation.density
      )
    },
    retention: {
      agentActivityDays: localChangeOrLatest(
        base.retention.agentActivityDays,
        candidate.retention.agentActivityDays,
        latest.retention.agentActivityDays
      ),
      auditDays: localChangeOrLatest(
        base.retention.auditDays,
        candidate.retention.auditDays,
        latest.retention.auditDays
      ),
      contentDays: localChangeOrLatest(
        base.retention.contentDays,
        candidate.retention.contentDays,
        latest.retention.contentDays
      ),
      evidenceDays: localChangeOrLatest(
        base.retention.evidenceDays,
        candidate.retention.evidenceDays,
        latest.retention.evidenceDays
      ),
      sandboxArtifactDays: localChangeOrLatest(
        base.retention.sandboxArtifactDays,
        candidate.retention.sandboxArtifactDays,
        latest.retention.sandboxArtifactDays
      )
    },
    synchronization: {
      cadence: localChangeOrLatest(
        base.synchronization.cadence,
        candidate.synchronization.cadence,
        latest.synchronization.cadence
      ),
      intervalMinutes: localChangeOrLatest(
        base.synchronization.intervalMinutes,
        candidate.synchronization.intervalMinutes,
        latest.synchronization.intervalMinutes
      ),
      staleAfterMinutes: localChangeOrLatest(
        base.synchronization.staleAfterMinutes,
        candidate.synchronization.staleAfterMinutes,
        latest.synchronization.staleAfterMinutes
      )
    }
  }
}

/** Own one session-isolated settings document and its explicit stale-write recovery. */
export const useWorkspaceSettings = (
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: WorkspaceSettingsTransport = browserWorkspaceSettingsTransport
): {
  readonly discardConflict: () => void
  readonly edit: (draft: WorkspaceSettingsV1) => void
  readonly reapplyConflict: () => void
  readonly retry: () => void
  readonly retryConflict: () => void
  readonly save: () => void
  readonly state: WorkspaceSettingsState
} => {
  const [state, setReactState] = useState<WorkspaceSettingsState>({ _tag: "idle" })
  const stateRef = useRef<WorkspaceSettingsState>(state)
  const [requestRevision, setRequestRevision] = useState(0)
  const activeRequest = useRef<AbortController | null>(null)
  const setState = useCallback((next: WorkspaceSettingsState): void => {
    stateRef.current = next
    setReactState(next)
  }, [])

  useEffect(() => {
    activeRequest.current?.abort()
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const request = new AbortController()
    activeRequest.current = request
    setState({ _tag: "loading" })
    transport.load(request.signal).then(
      (server) => {
        if (!request.signal.aborted) {
          publishWorkspaceSettings(server)
          setState({
            _tag: "ready",
            draft: server.settings,
            pendingMutationId: null,
            server,
            status: "saved"
          })
        }
      },
      (failure) => {
        if (request.signal.aborted) return
        if (isUnauthorized(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed" })
      }
    )
    return () => request.abort()
  }, [onSessionExpired, requestRevision, sessionKey, setState, transport])

  const edit = useCallback((draft: WorkspaceSettingsV1): void => {
    const current = stateRef.current
    if (current._tag !== "ready" || current.status === "saving") return
    setState({
      ...current,
      draft,
      pendingMutationId: null,
      status: changedWorkspaceSettingsSections(current.server.settings, draft).length === 0
        ? "saved"
        : "dirty"
    })
  }, [setState])

  const save = useCallback((): void => {
    if (sessionKey === null) return
    const current = stateRef.current
    if (
      current._tag !== "ready" ||
      (current.status !== "dirty" && current.status !== "failed")
    ) return
    const request = new AbortController()
    activeRequest.current?.abort()
    activeRequest.current = request
    const base = current.server
    const candidate = current.draft
    const changed = changedWorkspaceSettingsSections(base.settings, candidate)
    const governed = changed.filter(isGovernedWorkspaceSettingsSection)
    setState({ ...current, status: "saving" })
    const mutationIdPromise = current.pendingMutationId === null
      ? transport.makeMutationId()
      : Promise.resolve(current.pendingMutationId)
    mutationIdPromise.then(
      (mutationId) => {
        transport.update({
          mutationId,
          expectedRevision: base.revision,
          settings: candidate,
          acknowledgedGovernedSections: governed
        }, request.signal).then(
          (server) => {
            if (request.signal.aborted) return
            publishWorkspaceSettings(server)
            setState({
              _tag: "ready",
              draft: server.settings,
              pendingMutationId: null,
              server,
              status: "saved"
            })
          },
          (failure) => {
            if (request.signal.aborted) return
            if (isUnauthorized(failure)) {
              onSessionExpired(sessionKey)
              setState({ _tag: "failed" })
              return
            }
            if (!isConflict(failure)) {
              setState({
                _tag: "ready",
                draft: candidate,
                pendingMutationId: mutationId,
                server: base,
                status: "failed"
              })
              return
            }
            transport.load(request.signal).then(
              (latest) => {
                if (!request.signal.aborted) {
                  publishWorkspaceSettings(latest)
                  setState({ _tag: "conflict", base, candidate, latest })
                }
              },
              (failure) => {
                if (request.signal.aborted) return
                if (isUnauthorized(failure)) {
                  onSessionExpired(sessionKey)
                  setState({ _tag: "failed" })
                  return
                }
                setState({ _tag: "conflict-recovery-failed", base, candidate })
              }
            )
          }
        )
      },
      () => {
        if (!request.signal.aborted) {
          setState({
            _tag: "ready",
            draft: candidate,
            pendingMutationId: null,
            server: base,
            status: "failed"
          })
        }
      }
    )
  }, [onSessionExpired, sessionKey, setState, transport])

  const discardConflict = useCallback((): void => {
    const current = stateRef.current
    if (current._tag !== "conflict") return
    setState({
      _tag: "ready",
      draft: current.latest.settings,
      pendingMutationId: null,
      server: current.latest,
      status: "saved"
    })
  }, [setState])

  const reapplyConflict = useCallback((): void => {
    const current = stateRef.current
    if (current._tag !== "conflict") return
    const draft = reapplyWorkspaceSettingsCandidate(
      current.base.settings,
      current.candidate,
      current.latest.settings
    )
    setState({
      _tag: "ready",
      draft,
      pendingMutationId: null,
      server: current.latest,
      status: changedWorkspaceSettingsSections(current.latest.settings, draft).length === 0
        ? "saved"
        : "dirty"
    })
  }, [setState])

  const retryConflict = useCallback((): void => {
    const current = stateRef.current
    if (current._tag !== "conflict-recovery-failed") return
    const request = new AbortController()
    activeRequest.current?.abort()
    activeRequest.current = request
    const { base, candidate } = current
    setState({ _tag: "conflict-recovery-loading", base, candidate })
    transport.load(request.signal).then(
      (latest) => {
        if (!request.signal.aborted) {
          publishWorkspaceSettings(latest)
          setState({ _tag: "conflict", base, candidate, latest })
        }
      },
      (failure) => {
        if (request.signal.aborted) return
        if (sessionKey !== null && isUnauthorized(failure)) {
          onSessionExpired(sessionKey)
          setState({ _tag: "failed" })
          return
        }
        setState({ _tag: "conflict-recovery-failed", base, candidate })
      }
    )
  }, [onSessionExpired, sessionKey, setState, transport])

  return {
    discardConflict,
    edit,
    reapplyConflict,
    retry: () => setRequestRevision((revision) => revision + 1),
    retryConflict,
    save,
    state
  }
}
