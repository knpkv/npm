import { Button, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type ReactElement, useCallback, useEffect, useState } from "react"

import type {
  BrowserPairingPermission,
  IssueBrowserPairingCodeResponse,
  SessionListResponse,
  SessionSummary
} from "../../api/session.js"
import type { SessionId } from "../../domain/identifiers.js"
import styles from "./BrowserSessionsPanel.module.css"
import {
  browserSessionAdministrationTransport,
  type BrowserSessionAdministrationTransport
} from "./browserSessionTransport.js"

type SessionsState =
  | { readonly _tag: "failed" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly sessions: SessionListResponse }

const permissionLabel = (permission: SessionSummary["permission"]): string =>
  permission === "workspace-owner"
    ? "Workspace owner"
    : permission === "workspace-approver"
      ? "Workspace approver"
      : permission

const sessionExpired = (session: SessionSummary, now = DateTime.nowUnsafe()): boolean =>
  DateTime.Order(now, session.idleExpiresAt) >= 0 || DateTime.Order(now, session.absoluteExpiresAt) >= 0

export const sessionStatus = (session: SessionSummary, now = DateTime.nowUnsafe()): string =>
  session.revokedAt !== null
    ? `Revoked ${DateTime.formatIso(session.revokedAt)}`
    : sessionExpired(session, now)
      ? `Expired · last used ${DateTime.formatIso(session.lastSeenAt)}`
      : `Active · last used ${DateTime.formatIso(session.lastSeenAt)}`

const copyPairingCode = async (pairingCode: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(pairingCode)
    return true
  } catch {
    return false
  }
}

/** Owner-facing browser pairing and independent session administration. */
export const BrowserSessionsPanel = ({
  canManage,
  currentSession,
  onSessionExpired,
  sessionKey,
  transport = browserSessionAdministrationTransport
}: {
  readonly canManage: boolean
  readonly currentSession: SessionSummary
  readonly onSessionExpired: (sessionKey: string) => void
  readonly sessionKey: string
  /** Injectable browser boundary for component acceptance tests. @internal */
  readonly transport?: BrowserSessionAdministrationTransport
}): ReactElement => {
  const [state, setState] = useState<SessionsState>({ _tag: "loading" })
  const [permission, setPermission] = useState<BrowserPairingPermission>("workspace-owner")
  const [issued, setIssued] = useState<IssueBrowserPairingCodeResponse | null>(null)
  const [issueState, setIssueState] = useState<"failed" | "idle" | "issuing">("idle")
  const [copied, setCopied] = useState(false)
  const [revokingSessionId, setRevokingSessionId] = useState<SessionId | null>(null)

  const load = useCallback(
    (signal: AbortSignal): void => {
      setState({ _tag: "loading" })
      void transport.list(signal).then(
        (sessions) => setState({ _tag: "ready", sessions }),
        (failure) => {
          if (signal.aborted) return
          if (Predicate.isTagged("UnauthorizedApiError")(failure)) onSessionExpired(sessionKey)
          setState({ _tag: "failed" })
        }
      )
    },
    [onSessionExpired, sessionKey, transport]
  )

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const issuePairingCode = (): void => {
    const controller = new AbortController()
    setIssueState("issuing")
    setIssued(null)
    setCopied(false)
    void transport.issuePairingCode(permission, controller.signal).then(
      (result) => {
        setIssued(result)
        setIssueState("idle")
      },
      (failure) => {
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) onSessionExpired(sessionKey)
        setIssueState("failed")
      }
    )
  }

  const revoke = (sessionId: SessionId): void => {
    const controller = new AbortController()
    setRevokingSessionId(sessionId)
    void transport.revoke(sessionId, controller.signal).then(
      () => {
        setRevokingSessionId(null)
        setIssued(null)
        load(new AbortController().signal)
      },
      (failure) => {
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) onSessionExpired(sessionKey)
        setRevokingSessionId(null)
      }
    )
  }

  return (
    <Surface as="section" className={styles.panel} padding="default" form="grouped">
      <div className={styles.heading}>
        <div>
          <Text as="h2" variant="section-title">
            Browsers
          </Text>
          <Text as="p" tone="secondary">
            Pair more browsers with a single-use code. Every browser gets its own session and can be revoked
            independently.
          </Text>
        </div>
        {state._tag === "failed" ? <Button onClick={() => load(new AbortController().signal)}>Retry</Button> : null}
      </div>

      {canManage ? (
        <div className={styles.pairing}>
          <label className={styles.permission}>
            <span>New browser access</span>
            <select
              disabled={issueState === "issuing"}
              onChange={(event) => {
                const next = event.currentTarget.value
                if (next === "workspace-owner" || next === "workspace-approver") setPermission(next)
              }}
              value={permission}
            >
              <option value="workspace-owner">Workspace owner</option>
              <option value="workspace-approver">Workspace approver</option>
            </select>
          </label>
          <Button loading={issueState === "issuing"} onClick={issuePairingCode} variant="primary">
            Add browser
          </Button>
        </div>
      ) : (
        <Text as="p" tone="secondary">
          A workspace owner can add or revoke browsers.
        </Text>
      )}

      {issueState === "failed" ? (
        <Text as="p" role="alert" tone="secondary">
          The pairing code could not be created. Try again.
        </Text>
      ) : null}
      {issued === null ? null : (
        <div className={styles.codeCard}>
          <div>
            <Text as="h3" variant="label">
              Pairing code
            </Text>
            <Text as="p" tone="secondary">
              In the other browser, open <strong>/pair</strong> and paste this code before{" "}
              {DateTime.formatIso(issued.expiresAt)}.
            </Text>
          </div>
          <code className={styles.code}>{issued.pairingCode}</code>
          <Button
            onClick={() => {
              void copyPairingCode(issued.pairingCode).then(setCopied)
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
      )}

      <div className={styles.sessions} aria-live="polite">
        {state._tag === "loading" ? (
          <Text as="p" tone="secondary">
            Loading paired browsers…
          </Text>
        ) : state._tag === "failed" ? (
          <Text as="p" tone="secondary">
            Paired browsers could not be loaded.
          </Text>
        ) : (
          state.sessions.map((session) => {
            const isCurrent = session.sessionId === currentSession.sessionId
            return (
              <article className={styles.session} key={session.sessionId}>
                <div>
                  <Text as="h3" variant="label">
                    {permissionLabel(session.permission)}
                    {isCurrent ? " · This browser" : ""}
                  </Text>
                  <Text as="p" tone="secondary">
                    {sessionStatus(session)}
                  </Text>
                </div>
                {canManage && !isCurrent && session.revokedAt === null && !sessionExpired(session) ? (
                  <Button loading={revokingSessionId === session.sessionId} onClick={() => revoke(session.sessionId)}>
                    Revoke
                  </Button>
                ) : null}
              </article>
            )
          })
        )}
      </div>
    </Surface>
  )
}
