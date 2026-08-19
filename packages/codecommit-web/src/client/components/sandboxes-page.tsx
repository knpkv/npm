import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { SandboxId } from "@knpkv/codecommit-core/Domain.js"
import { Button, StateLabel, StatePanel, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import { useNavigate } from "react-router"
import { type AppState, appStateAtom, deleteSandboxAtom, restartSandboxAtom, stopSandboxAtom } from "../atoms/app.js"
import styles from "./sandbox.module.css"

const provisioningStatuses = new Set(["creating", "cloning", "starting"])

const isProvisioning = (status: string): boolean => provisioningStatuses.has(status)

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

const formatTime = (timestamp: string): string => {
  const createdAt = new Date(timestamp)
  const elapsed = Date.now() - createdAt.getTime()
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

interface SandboxActionRequest {
  readonly params: { readonly sandboxId: SandboxId }
}

export interface SandboxesPageViewProps {
  readonly state: AppState
  readonly stopSandbox: (request: SandboxActionRequest) => void
  readonly restartSandbox: (request: SandboxActionRequest) => void
  readonly deleteSandbox: (request: SandboxActionRequest) => void
  readonly navigate: (href: string) => void
}

/** Inventory route wired to the application atom and router boundaries. */
export function SandboxesPage() {
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()
  return (
    <SandboxesPageView
      deleteSandbox={deleteSandbox}
      navigate={navigate}
      restartSandbox={restartSandbox}
      state={state}
      stopSandbox={stopSandbox}
    />
  )
}

/** Inventory presentation with explicit lifecycle and navigation dependencies. */
export function SandboxesPageView({
  deleteSandbox,
  navigate,
  restartSandbox,
  state,
  stopSandbox
}: SandboxesPageViewProps) {
  const sandboxes = state.sandboxes ?? []
  const runningCount = sandboxes.filter(({ status }) => status === "running").length

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Isolated review environments</span>
          <Text as="h1" className={styles.title} variant="page-title">
            Sandboxes
          </Text>
          <Text className={styles.lede} tone="secondary" variant="body-large">
            Open a revision in its own authenticated workspace, then keep lifecycle and logs in view.
          </Text>
        </div>
        <StateLabel
          label={runningCount === 1 ? "1 running" : `${String(runningCount)} running`}
          tone={runningCount > 0 ? "positive" : "neutral"}
        />
      </header>

      {sandboxes.length === 0 ? (
        <StatePanel
          action={
            <Button className={styles.emptyAction} onClick={() => navigate("/")} variant="secondary">
              Open pull requests
            </Button>
          }
          className={styles.empty}
          description='Choose a pull request, then select "Sandbox" or press "." to create an isolated review workspace.'
          title="No sandboxes yet"
        />
      ) : (
        <section aria-labelledby="sandbox-inventory-heading" className={styles.inventory}>
          <div className={styles.sectionHeader}>
            <Text as="h2" className={styles.sectionTitle} id="sandbox-inventory-heading" variant="section-title">
              Review environments
            </Text>
            <Text tone="tertiary" variant="meta">
              {sandboxes.length === 1 ? "1 sandbox" : `${String(sandboxes.length)} sandboxes`}
            </Text>
          </div>

          <div className={styles.sandboxList}>
            {sandboxes.map((sandbox) => {
              const canStop = sandbox.status === "running" || isProvisioning(sandbox.status)
              const canRestart = (sandbox.status === "stopped" || sandbox.status === "error") && sandbox.containerId
              const canDelete = sandbox.status === "stopped" || sandbox.status === "error"

              return (
                <article className={styles.sandboxRow} key={sandbox.id}>
                  <div className={styles.sandboxIdentity}>
                    <button
                      aria-label={`Open ${sandbox.repositoryName} sandbox for pull request ${sandbox.pullRequestId}`}
                      className={styles.sandboxOpen}
                      onClick={() => navigate(`/sandbox/${sandbox.id}`)}
                      type="button"
                    >
                      <span className={styles.sandboxHeading}>
                        <span className={styles.repository}>{sandbox.repositoryName}</span>
                        <span className={styles.branch}>{sandbox.sourceBranch}</span>
                        <StateLabel
                          label={statusLabel(sandbox.status)}
                          size="compact"
                          tone={statusTone(sandbox.status)}
                        />
                      </span>
                      <span className={styles.sandboxMeta}>
                        <span>PR #{sandbox.pullRequestId}</span>
                        <span aria-hidden="true" className={styles.metaSeparator}>
                          ·
                        </span>
                        <span>{formatTime(sandbox.createdAt)}</span>
                        {sandbox.port !== null && sandbox.status === "running" ? (
                          <>
                            <span aria-hidden="true" className={styles.metaSeparator}>
                              ·
                            </span>
                            <span className={styles.port}>port {sandbox.port}</span>
                          </>
                        ) : null}
                        {sandbox.statusDetail !== null && isProvisioning(sandbox.status) ? (
                          <>
                            <span aria-hidden="true" className={styles.metaSeparator}>
                              ·
                            </span>
                            <span className={styles.statusDetailInline}>{sandbox.statusDetail}</span>
                          </>
                        ) : null}
                      </span>
                    </button>
                    {sandbox.error === null ? null : <p className={styles.errorMessage}>{sandbox.error}</p>}
                  </div>

                  <div aria-label={`Actions for ${sandbox.repositoryName}`} className={styles.rowActions} role="group">
                    {sandbox.logs === null ? null : (
                      <Button
                        onClick={() => navigate(`/sandbox/${sandbox.id}?view=logs`)}
                        size="compact"
                        variant="quiet"
                      >
                        Logs
                      </Button>
                    )}
                    {canStop ? (
                      <Button
                        onClick={() => stopSandbox({ params: { sandboxId: SandboxId.make(sandbox.id) } })}
                        size="compact"
                        variant="secondary"
                      >
                        Stop
                      </Button>
                    ) : null}
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
                        onClick={() => deleteSandbox({ params: { sandboxId: SandboxId.make(sandbox.id) } })}
                        size="compact"
                        variant="quiet"
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
