import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { SandboxId } from "@knpkv/codecommit-core/Domain.js"
import { Button, StateLabel, StatePanel, type RlyStateTone } from "@knpkv/rly/primitives"
import { AsyncResult } from "effect/unstable/reactivity"
import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import {
  appStateAtom,
  deleteSandboxAtom,
  restartSandboxAtom,
  sandboxCredentialsAtom,
  stopSandboxAtom
} from "../atoms/app.js"
import { sandboxBrowserUrl } from "../sandbox-origin.js"
import styles from "./sandbox.module.css"

const provisioningStatuses = new Set(["creating", "cloning", "starting"])

const statusTone = (status: string): RlyStateTone => {
  switch (status) {
    case "running":
      return "positive"
    case "creating":
    case "cloning":
    case "starting":
    case "stopping":
      return "progress"
    case "error":
      return "critical"
    default:
      return "neutral"
  }
}

const statusLabel = (status: string): string =>
  status.length === 0 ? "Unknown" : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`

const LogPanel = ({ logs }: { readonly logs: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs])

  const lines = logs.trimEnd().split("\n")
  return (
    <div aria-label="Sandbox logs" className={styles.logs} ref={ref} role="log">
      {lines.map((line, index) => {
        const match = line.match(/^\[([^\]]+)\]\s*(.*)$/)
        const timestamp = match?.[1]
        const message = match?.[2] ?? line
        return (
          <div className={styles.logLine} key={`${timestamp ?? "line"}-${String(index)}`}>
            {timestamp === undefined ? null : <span className={styles.logTimestamp}>{timestamp}</span>}
            <span className={styles.logMessage}>{message}</span>
          </div>
        )
      })}
    </div>
  )
}

const SandboxCredentialsBar = ({ sandboxId }: { readonly sandboxId: SandboxId }) => {
  const credentials = useAtomValue(sandboxCredentialsAtom(sandboxId))
  const [revealed, setRevealed] = useState(false)

  if (AsyncResult.isFailure(credentials)) {
    return (
      <div className={styles.credentialFailure} role="alert">
        Unable to load the code-server password. Reload the sandbox after checking the owner session.
      </div>
    )
  }

  const accessPassword = AsyncResult.isSuccess(credentials) ? credentials.value.password : null
  return (
    <div className={styles.credentialBar}>
      <span className={styles.credentialLabel}>Authenticated owner access</span>
      <code className={styles.credentialCode}>
        {accessPassword === null ? "Loading…" : revealed ? accessPassword : "••••••••••••"}
      </code>
      <div aria-label="Sandbox credential actions" className={styles.credentialActions} role="group">
        <button
          aria-label={revealed ? "Hide code-server password" : "Reveal code-server password"}
          className={styles.credentialButton}
          disabled={accessPassword === null}
          onClick={() => setRevealed((current) => !current)}
          type="button"
        >
          {revealed ? <EyeOffIcon aria-hidden="true" size={16} /> : <EyeIcon aria-hidden="true" size={16} />}
        </button>
        <button
          aria-label="Copy code-server password"
          className={styles.credentialButton}
          disabled={accessPassword === null}
          onClick={() => {
            if (accessPassword !== null) void navigator.clipboard.writeText(accessPassword)
          }}
          type="button"
        >
          <CopyIcon aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  )
}

/** Full-width authenticated sandbox workspace with explicit lifecycle and credential boundaries. */
export function SandboxView() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()
  const [showLogs, setShowLogs] = useState(searchParams.get("view") === "logs")

  const sandbox = useMemo(
    () => state.sandboxes?.find((candidate) => candidate.id === sandboxId) ?? null,
    [sandboxId, state.sandboxes]
  )

  const selectView = useCallback(
    (view: "editor" | "logs") => {
      const nextShowsLogs = view === "logs"
      setShowLogs(nextShowsLogs)
      setSearchParams(nextShowsLogs ? { view: "logs" } : {}, { preventScrollReset: true, replace: true })
    },
    [setSearchParams]
  )

  const handleStop = useCallback(() => {
    if (sandboxId === undefined) return
    stopSandbox({ params: { sandboxId: SandboxId.make(sandboxId) } })
  }, [sandboxId, stopSandbox])

  if (sandbox === null) {
    return (
      <div className={styles.loadingPage}>
        <StatePanel
          announce="polite"
          className={styles.loadingPanel}
          description="CodeCommit is loading the isolated review workspace and its current lifecycle state."
          title="Loading sandbox"
          tone="progress"
        />
      </div>
    )
  }

  const isRunning = sandbox.status === "running"
  const isProvisioning = provisioningStatuses.has(sandbox.status)
  const displaysLogs = showLogs || !isRunning
  const canRestart = (sandbox.status === "stopped" || sandbox.status === "error") && sandbox.containerId !== null
  const canDelete = sandbox.status === "stopped" || sandbox.status === "error"
  const canStop = isRunning || isProvisioning
  const backUrl = `/accounts/${sandbox.awsAccountId}/prs/${sandbox.pullRequestId}`

  return (
    <div className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceIdentity}>
          <Button
            className={styles.backButton}
            leadingIcon="arrow-left"
            onClick={() => navigate(backUrl)}
            size="compact"
            variant="quiet"
          >
            Back to PR
          </Button>
          <div className={styles.workspaceHeading}>
            <p className={styles.workspaceTitle}>
              <span className={styles.sandboxId}>{sandbox.repositoryName}</span> / {sandbox.sourceBranch}
            </p>
            <p className={styles.workspaceMeta}>
              PR #{sandbox.pullRequestId} · {sandbox.id}
            </p>
          </div>
          <StateLabel label={statusLabel(sandbox.status)} size="compact" tone={statusTone(sandbox.status)} />
        </div>

        <div aria-label="Sandbox workspace actions" className={styles.workspaceActions} role="group">
          {sandbox.logs === null ? null : (
            <div aria-label="Workspace view" className={styles.viewActions} role="group">
              {isRunning ? (
                <Button
                  aria-pressed={!displaysLogs}
                  onClick={() => selectView("editor")}
                  size="compact"
                  variant={!displaysLogs ? "primary" : "quiet"}
                >
                  Editor
                </Button>
              ) : null}
              <Button
                aria-pressed={displaysLogs}
                onClick={() => selectView("logs")}
                size="compact"
                variant={displaysLogs ? "primary" : "quiet"}
              >
                Logs
              </Button>
            </div>
          )}
          {canRestart ? (
            <Button
              onClick={() => restartSandbox({ params: { sandboxId: SandboxId.make(sandbox.id) } })}
              size="compact"
              variant="secondary"
            >
              Restart
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              onClick={() => {
                deleteSandbox({ params: { sandboxId: SandboxId.make(sandbox.id) } })
                navigate("/sandboxes")
              }}
              size="compact"
              variant="quiet"
            >
              Delete
            </Button>
          ) : null}
          {canStop ? (
            <Button onClick={handleStop} size="compact" variant="secondary">
              Stop
            </Button>
          ) : null}
        </div>
      </header>

      {isRunning && !displaysLogs ? <SandboxCredentialsBar sandboxId={SandboxId.make(sandbox.id)} /> : null}

      {displaysLogs ? (
        <div className={styles.workspaceContent}>
          {sandbox.statusDetail === null && sandbox.error === null ? null : (
            <div className={styles.workspaceNotice}>
              {sandbox.statusDetail === null ? null : <p className={styles.statusDetail}>{sandbox.statusDetail}</p>}
              {sandbox.error === null ? null : (
                <StatePanel
                  announce="assertive"
                  description={sandbox.error}
                  title="Sandbox stopped before readiness"
                  tone="critical"
                />
              )}
            </div>
          )}
          {sandbox.logs === null ? (
            <div className={styles.noLogs}>
              <StatePanel
                description={
                  isProvisioning
                    ? "Logs will appear as the reviewed revision is cloned and prepared."
                    : "This sandbox did not retain lifecycle logs."
                }
                title={isProvisioning ? "Preparing the revision" : "No logs available"}
                tone={isProvisioning ? "progress" : "neutral"}
              />
            </div>
          ) : (
            <LogPanel logs={sandbox.logs} />
          )}
        </div>
      ) : (
        <iframe
          className={styles.editorFrame}
          src={sandbox.port === null ? undefined : sandboxBrowserUrl(window.location.hostname, sandbox.port)}
          title={`${sandbox.repositoryName} code sandbox`}
        />
      )}
    </div>
  )
}
