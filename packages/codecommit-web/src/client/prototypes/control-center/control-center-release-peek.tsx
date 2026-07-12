import { X } from "lucide-react"
import type { RefObject } from "react"
import { AgentThread } from "./control-center-agent-thread.js"
import { CollaboratorStack, releaseCollaborators } from "./control-center-collaborators.js"
import { ServiceIcon } from "./control-center-foundation.js"
import { releaseWorksets, type WorkEvent } from "./control-center-model.js"
import { ReleaseSigil } from "./control-center-release-sigil.js"
import type { AgentThreadEntry } from "./control-center-state.js"

interface ReleaseSummary {
  readonly service: string
  readonly version: string
  readonly state: string
  readonly tone: string
  readonly detail: string
  readonly stages: ReadonlyArray<string>
}

interface ReleasePeekDialogProps {
  readonly acknowledgedReleases: ReadonlyArray<number>
  readonly agentEntries: ReadonlyArray<AgentThreadEntry>
  readonly buildNotifications: ReadonlyArray<number>
  readonly closeRef: RefObject<HTMLButtonElement | null>
  readonly deployStarted: boolean
  readonly dialogRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly onAgentEntriesChange: (entries: ReadonlyArray<AgentThreadEntry>) => void
  readonly onOpenEntity: (entityId: string) => void
  readonly onOpenFull: () => void
  readonly onPrimaryAction: (releaseIndex: number) => void
  readonly onRepair: (releaseIndex: number) => void
  readonly releaseIndex: number
  readonly releases: ReadonlyArray<ReleaseSummary>
  readonly repairedReleases: ReadonlyArray<number>
  readonly riskLinkedPrId: string
  readonly riskLinkedPrNumber: string
  readonly riskPrRepaired: boolean
  readonly riskRepairCount: number
  readonly riskRunbookRepaired: boolean
  readonly watchedReleases: ReadonlyArray<number>
  readonly presentation?: "dialog" | "page"
}

export function ReleasePeekDialog({
  acknowledgedReleases,
  agentEntries,
  buildNotifications,
  closeRef,
  deployStarted,
  dialogRef,
  onAgentEntriesChange,
  onClose,
  onOpenEntity,
  onOpenFull,
  onPrimaryAction,
  onRepair,
  presentation = "dialog",
  releaseIndex,
  releases,
  repairedReleases,
  riskLinkedPrId,
  riskLinkedPrNumber,
  riskPrRepaired,
  riskRepairCount,
  riskRunbookRepaired,
  watchedReleases
}: ReleasePeekDialogProps) {
  const release = releases[releaseIndex]
  const worksetBase = releaseWorksets[releaseIndex]
  if (!release || !worksetBase) return null
  const rolloutEvent: WorkEvent = ["10:24", "Production rollout started", "10% canary · 4% complete"]
  const workset =
    releaseIndex === 1 && deployStarted
      ? {
          ...worksetBase,
          events: [rolloutEvent, ...worksetBase.events]
        }
      : worksetBase
  const linkedKeys = new Set<string>(workset.prs.flatMap(([, keys]) => [...keys]))
  const originalUnlinkedTickets = workset.tickets.filter(([key]) => !linkedKeys.has(key))
  const repairApplied = repairedReleases.includes(releaseIndex)
  const unlinkedTickets = repairApplied
    ? []
    : releaseIndex === 5
      ? originalUnlinkedTickets.filter(([key]) =>
          key === "RISK-61" ? !riskPrRepaired : key === "DOC-106" ? !riskRunbookRepaired : true
        )
      : originalUnlinkedTickets
  const effectiveGaps = repairApplied ? 0 : releaseIndex === 5 ? 2 - riskRepairCount : workset.gaps

  const releaseCard = (
    <section
      ref={dialogRef}
      className={`cc-release-peek ${release.tone}${presentation === "page" ? " cc-release-full" : ""}`}
      role={presentation === "dialog" ? "dialog" : undefined}
      aria-modal={presentation === "dialog" ? true : undefined}
      aria-label={`${release.service} ${release.version}`}
    >
      <header>
        <span className="cc-release-signal" />
        <ReleaseSigil service={release.service} />
        <div>
          <small>{release.service}</small>
          <h2>{release.version}</h2>
        </div>
        {presentation === "dialog" && (
          <button ref={closeRef} aria-label="Close release" onClick={onClose}>
            <X size={20} />
          </button>
        )}
      </header>
      <div className="cc-peek-verdict">
        <span>{release.state}</span>
        <p>{release.detail}</p>
        <CollaboratorStack people={releaseCollaborators[release.service] ?? []} />
      </div>
      <AgentThread
        entries={agentEntries}
        onChange={onAgentEntriesChange}
        release={`${release.service}:${release.version}`}
        state={release.state}
      />
      <div className="cc-peek-stages">
        {release.stages.map((stage, index) => (
          <div key={`${stage}-${index}`}>
            <small>{index === 0 ? "BUILD" : index === 1 ? "TESTS" : "PRODUCTION"}</small>
            <b>{stage}</b>
          </div>
        ))}
      </div>
      <div className="cc-peek-workset">
        <header>
          <ServiceIcon service="jira" />
          <b>6 Jira items</b>
          <span>
            {workset.prs.length + (repairApplied && releaseIndex === 5 ? 1 : 0)} PRs · 1 pipeline · {effectiveGaps} gaps
          </span>
        </header>
        <div>
          <section>
            {workset.prs.map(([pr, keys]) => (
              <div className="cc-peek-pr" key={pr}>
                <button
                  className="cc-peek-pr-head"
                  onClick={() => onOpenEntity(`pr:${release.service}:${pr.replace("#", "")}`)}
                >
                  <ServiceIcon service="code" />
                  PR {pr}
                </button>
                {keys.map((key) => {
                  const ticket = workset.tickets.find(([ticketKey]) => ticketKey === key)!
                  return (
                    <button key={key} onClick={() => onOpenEntity(`jira:${key}`)}>
                      <small>{key}</small>
                      {ticket[1]}
                    </button>
                  )
                })}
              </div>
            ))}
            {repairApplied && releaseIndex === 3 && originalUnlinkedTickets.length > 0 && (
              <div className="cc-peek-pr">
                <button className="cc-peek-pr-head" onClick={() => onOpenEntity("page:RUN-67")}>
                  <ServiceIcon service="confluence" />
                  RUN-67
                </button>
                {originalUnlinkedTickets.map(([key, title]) => (
                  <button key={key} onClick={() => onOpenEntity(`jira:${key}`)}>
                    <small>{key}</small>
                    {title}
                  </button>
                ))}
              </div>
            )}
            {releaseIndex === 5 && (riskPrRepaired || riskRunbookRepaired) && (
              <>
                {riskPrRepaired && (
                  <div className="cc-peek-pr">
                    <button className="cc-peek-pr-head" onClick={() => onOpenEntity(riskLinkedPrId)}>
                      <ServiceIcon service="code" />
                      PR #{riskLinkedPrNumber}
                    </button>
                    <button onClick={() => onOpenEntity("jira:RISK-61")}>
                      <small>RISK-61</small>Explain score overrides
                    </button>
                  </div>
                )}
                {riskRunbookRepaired && (
                  <div className="cc-peek-pr">
                    <button className="cc-peek-pr-head" onClick={() => onOpenEntity("page:RUN-54")}>
                      <ServiceIcon service="confluence" />
                      RUN-54
                    </button>
                    <button onClick={() => onOpenEntity("jira:DOC-106")}>
                      <small>DOC-106</small>Analyst rollout guide
                    </button>
                  </div>
                )}
              </>
            )}
            {unlinkedTickets.length > 0 && (
              <div className="cc-peek-pr missing">
                <b>Missing relationship</b>
                {unlinkedTickets.map(([key, title]) => (
                  <button key={key} onClick={() => onRepair(releaseIndex)}>
                    <small>{key}</small>
                    {title}
                  </button>
                ))}
              </div>
            )}
          </section>
          <aside>
            <b>
              <ServiceIcon service="pipeline" />
              {workset.pipeline}
            </b>
            {workset.events.slice(0, 4).map(([time, label]) => (
              <button key={`${time}-${label}`} onClick={() => onOpenEntity(`pipeline:${release.service}`)}>
                <small>{time}</small>
                <span>{label}</span>
              </button>
            ))}
          </aside>
        </div>
        <footer>
          <ServiceIcon service="confluence" />
          <span>
            {riskRunbookRepaired && releaseIndex === 5
              ? "RUN-54 · Risk analyst rollout guide · revision published"
              : workset.confluence}
          </span>
          <button
            onClick={() =>
              onOpenEntity(
                riskRunbookRepaired && releaseIndex === 5 ? "page:RUN-54" : `page:${workset.confluence.split(" ")[0]}`
              )
            }
          >
            Open
          </button>
        </footer>
      </div>
      <section>
        <h3>Agent brief</h3>
        <p>
          {release.tone === "ready"
            ? "All required checks and approvals are present. This release can deploy safely."
            : release.tone === "moving"
              ? "The rollout is healthy. Error rate and latency remain within the expected range."
              : release.tone === "shipped"
                ? "The release is live and stable. No rollback signals detected."
                : release.tone === "building"
                  ? effectiveGaps > 0
                    ? "Build can continue, but one documentation gap must be fixed before release."
                    : "Four build jobs are still running; no release action is needed yet."
                  : release.tone === "warning"
                    ? "Delivery is held because two changes cannot be traced back to approved work."
                    : "The release is blocked. Investigate the failed tests before requesting production approval."}
        </p>
        <div className="cc-state-details">
          {release.tone === "ready" && (
            <>
              <b>Deployment confirmation</b>
              <span>Production · {release.version}</span>
              <span>✓ Checks passed · ✓ approval recorded</span>
              <label>
                Rollout
                <select defaultValue="canary">
                  <option value="canary">10% canary, then 100%</option>
                  <option value="all">Immediate 100%</option>
                </select>
              </label>
            </>
          )}
          {release.tone === "moving" && (
            <>
              <b>Live rollout telemetry</b>
              <span>Progress {release.service === "checkout-web" ? "4%" : "62%"} · error rate 0.04%</span>
              <span>p95 latency 184ms · rollback threshold 1.0%</span>
            </>
          )}
          {release.tone === "building" && (
            <>
              <b>Active build jobs</b>
              <span>8 passed · 4 running · 0 failed</span>
              <span>worker-image 67% · integration queued</span>
            </>
          )}
          {release.tone === "shipped" && (
            <>
              <b>Production evidence</b>
              <span>{release.version} live in all regions · 24m</span>
              <span>Health 99.99% · no rollback signals</span>
            </>
          )}
          {release.tone === "warning" && (
            <>
              <b>Trace repair</b>
              <span>{effectiveGaps} evidence gaps block promotion</span>
              <span>Select each missing Jira, PR, or runbook relationship above.</span>
            </>
          )}
        </div>
      </section>
      <footer>
        <button onClick={presentation === "dialog" ? onOpenFull : onClose}>
          {presentation === "dialog" ? "Open full view" : "All releases"}
        </button>
        <button className="primary" onClick={() => onPrimaryAction(releaseIndex)}>
          {release.tone === "ready"
            ? "Confirm deploy"
            : release.tone === "moving"
              ? watchedReleases.includes(releaseIndex)
                ? "Watching"
                : "Watch rollout"
              : release.tone === "building"
                ? buildNotifications.includes(releaseIndex)
                  ? "Notification on"
                  : "Notify when done"
                : release.tone === "shipped"
                  ? acknowledgedReleases.includes(releaseIndex)
                    ? "Acknowledged"
                    : "Acknowledge evidence"
                  : "Repair trace"}
        </button>
      </footer>
    </section>
  )

  if (presentation === "page") {
    return <div className="cc-release-full-page">{releaseCard}</div>
  }

  return (
    <div
      className="cc-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      {releaseCard}
    </div>
  )
}
