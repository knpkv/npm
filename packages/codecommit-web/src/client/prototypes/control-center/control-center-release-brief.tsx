import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  Link2,
  Network,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X
} from "lucide-react"
import type { Dispatch, SetStateAction } from "react"
import type { ActionView, AgentScope, ApprovalState } from "./control-center-action-panel.js"
import { AgentThread } from "./control-center-agent-thread.js"
import { CollaboratorStack, releaseCollaborators } from "./control-center-collaborators.js"
import { ServiceIcon } from "./control-center-foundation.js"
import { releaseTickets, releaseWorksets, type TraceId } from "./control-center-model.js"
import { ReleaseSigil } from "./control-center-release-sigil.js"
import type { AgentThreadEntry } from "./control-center-state.js"

interface ReleaseBriefProps {
  readonly agentEntries: ReadonlyArray<AgentThreadEntry>
  readonly advanceApproval: () => void
  readonly approvalRecorded: boolean
  readonly approvalState: ApprovalState
  readonly entityActions: Readonly<Record<string, boolean>>
  readonly fixesApplied: boolean
  readonly inspectTrace: (trace: TraceId) => void
  readonly linkedPr: string | null
  readonly openExternalObject: (entityId: string) => void
  readonly onAgentEntriesChange: (entries: ReadonlyArray<AgentThreadEntry>) => void
  readonly onBack: () => void
  readonly pay119Linked: boolean
  readonly pipelineRetryAudit: { readonly time: string } | undefined
  readonly setActionView: Dispatch<SetStateAction<ActionView | null>>
  readonly setAgentScope: Dispatch<SetStateAction<AgentScope>>
  readonly setNotice: Dispatch<SetStateAction<string | null>>
  readonly setSelectedTicket: Dispatch<SetStateAction<number>>
}

interface PullRequestGroup {
  readonly number: string
  readonly state: string
  readonly ticketIndexes: ReadonlyArray<number>
  readonly trace: TraceId
}

const pullRequestGroups: ReadonlyArray<PullRequestGroup> = [
  { trace: "prOne", number: "#284", ticketIndexes: [0, 2, 3], state: "Merged · verified" },
  { trace: "prTwo", number: "#279", ticketIndexes: [1, 4], state: "Merged · tests failing" }
]

export function ReleaseBrief({
  advanceApproval,
  agentEntries,
  approvalRecorded,
  approvalState,
  entityActions,
  fixesApplied,
  inspectTrace,
  linkedPr,
  onAgentEntriesChange,
  onBack,
  openExternalObject,
  pay119Linked,
  pipelineRetryAudit,
  setActionView,
  setAgentScope,
  setNotice,
  setSelectedTicket
}: ReleaseBriefProps) {
  const pay119Ticket = releaseTickets.find(({ key }) => key === "PAY-119")
  return (
    <section className="cc-release-brief">
      <button className="cc-release-full-back" onClick={onBack}>
        <ArrowLeft size={16} />
        All releases
      </button>
      <header>
        <div>
          <span className="cc-brief-eyebrow">PAYMENTS-API · RELEASE 2.18.0</span>
          <h1>Can’t ship.</h1>
          <p>Three checkout tests failed. Production has not started.</p>
          <ReleaseSigil service="payments-api" size="hero" />
          <div className="cc-verdict-evidence">
            <ShieldCheck size={15} />
            {approvalRecorded
              ? "1 verified blocker · pipeline failure"
              : "2 verified blockers · pipeline failure + missing approval"}
          </div>
          <CollaboratorStack people={releaseCollaborators["payments-api"] ?? []} />
        </div>
        <button
          className="cc-brief-status"
          onClick={() => {
            setAgentScope("investigation")
            setActionView("agent")
          }}
        >
          <Sparkles size={18} />
          Investigate failed tests
        </button>
      </header>
      <AgentThread
        entries={agentEntries}
        onChange={onAgentEntriesChange}
        release="payments-api:2.18.0"
        state="Can’t ship"
      />
      <div className="cc-delivery-strip">
        <button onClick={() => inspectTrace("release")}>
          <span className="purple">
            <Box size={24} />
          </span>
          <div>
            <small>BUILD</small>
            <b>Built</b>
          </div>
          <Check size={20} />
        </button>
        <ArrowRight size={14} />
        <button onClick={() => inspectTrace("pipeline")}>
          <span className="blue">
            <Network size={24} />
          </span>
          <div>
            <small>TESTS</small>
            <b>3 failed</b>
          </div>
        </button>
        <ArrowRight size={14} />
        <button onClick={() => inspectTrace("deploy")}>
          <span className="green">
            <Play size={24} />
          </span>
          <div>
            <small>PRODUCTION</small>
            <b>Not deployed</b>
          </div>
        </button>
      </div>
      <div className="cc-brief-section-head">
        <div>
          <h2>Blocking ship</h2>
          <span>{1 + Number(!approvalRecorded) + Number(!pay119Linked)} actions needed</span>
        </div>
      </div>
      <div className="cc-blocking-list">
        <article>
          <span className="red">
            <X size={20} />
          </span>
          <div>
            <small>TESTS · LIKELY PR #279</small>
            <h3>Checkout runs twice</h3>
            <p>3 integration tests fail after the checkout fix.</p>
          </div>
          <button
            className="primary"
            onClick={() => {
              setAgentScope("investigation")
              setActionView("agent")
            }}
          >
            Investigate
          </button>
        </article>
        {!approvalRecorded && (
          <article>
            <span className="amber">
              <TriangleAlert size={20} />
            </span>
            <div>
              <small>APPROVAL · MAYA CHEN</small>
              <h3>Production approval needed</h3>
              <p>OPS-412 is ready, but approval has not been recorded.</p>
            </div>
            <button
              onClick={() => {
                advanceApproval()
                setNotice(
                  approvalState === "not-requested"
                    ? "Approval requested from Maya Chen"
                    : approvalState === "requested"
                      ? "Approval received from Maya Chen"
                      : "Approval recorded in Jira OPS-412-APR-9"
                )
              }}
            >
              {approvalState === "not-requested"
                ? "Request approval"
                : approvalState === "requested"
                  ? "Refresh approval"
                  : approvalState === "approved"
                    ? "Record in Jira"
                    : "Recorded"}
            </button>
          </article>
        )}
      </div>
      {!pay119Linked && (
        <button
          className="cc-also-noticed"
          onClick={() => {
            setSelectedTicket(5)
            inspectTrace("ticket")
          }}
        >
          <Link2 size={16} />
          <span>
            <b>Also noticed</b> · Refund telemetry has no linked PR
          </span>
          <ArrowRight size={14} />
        </button>
      )}
      <section className="cc-release-workset" aria-label="Release work and delivery stream">
        <header>
          <div>
            <ServiceIcon service="jira" />
            <span>
              <small>WORK INCLUDED</small>
              <b>6 Jira items</b>
            </span>
          </div>
          <span>{fixesApplied ? "6 linked to code · 0 gaps" : "5 linked to code · 1 PR gap · 1 approval gap"}</span>
        </header>
        <div className="cc-workset-grid">
          <div className="cc-jira-set">
            <div className="cc-pr-groups">
              {pullRequestGroups.map((group) => (
                <section className={group.trace === "prTwo" ? "cc-pr-group failing" : "cc-pr-group"} key={group.trace}>
                  <button className="cc-pr-group-head" onClick={() => inspectTrace(group.trace)}>
                    <ServiceIcon service="code" />
                    <span>
                      <small>PULL REQUEST</small>
                      <b>PR {group.number}</b>
                    </span>
                    <em>{group.state}</em>
                  </button>
                  <div>
                    {group.ticketIndexes.map((ticketIndex) => {
                      const item = releaseTickets[ticketIndex]
                      if (!item) {
                        return null
                      }
                      return (
                        <button
                          className={`cc-ticket-core ${item.tone}`}
                          aria-label={`${item.key}: ${item.title}. ${item.status}`}
                          key={item.key}
                          onClick={() => {
                            setSelectedTicket(ticketIndex)
                            inspectTrace("ticket")
                          }}
                        >
                          <i>{item.tone === "done" ? <Check size={11} /> : <TriangleAlert size={11} />}</i>
                          <span>
                            <small>{item.key}</small>
                            <b>{item.title}</b>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
              {fixesApplied && linkedPr && (
                <section className="cc-pr-group">
                  <button className="cc-pr-group-head" onClick={() => setNotice(`PR ${linkedPr} opened in CodeCommit`)}>
                    <ServiceIcon service="code" />
                    <span>
                      <small>PULL REQUEST</small>
                      <b>PR {linkedPr}</b>
                    </span>
                    <em>Open · review ready · linked</em>
                  </button>
                  <div>
                    <button
                      className="cc-ticket-core done"
                      onClick={() => {
                        setSelectedTicket(5)
                        inspectTrace("ticket")
                      }}
                    >
                      <i>
                        <Check size={11} />
                      </i>
                      <span>
                        <small>PAY-119</small>
                        <b>Refund-flow telemetry</b>
                      </span>
                    </button>
                  </div>
                </section>
              )}
            </div>
            {!fixesApplied && pay119Ticket && (
              <section className="cc-unlinked-ticket">
                <button
                  className="cc-ticket-core missing"
                  aria-label={`${pay119Ticket.key}: ${pay119Ticket.title}. ${pay119Ticket.status}`}
                  onClick={() => {
                    setSelectedTicket(5)
                    inspectTrace("ticket")
                  }}
                >
                  <i>
                    <TriangleAlert size={11} />
                  </i>
                  <span>
                    <small>{pay119Ticket.key}</small>
                    <b>{pay119Ticket.title}</b>
                  </span>
                </button>
                <button onClick={() => setActionView("linkPr")}>
                  <Plus size={13} />
                  Link pull request
                </button>
              </section>
            )}
          </div>
          <aside className="cc-pipeline-stream">
            <header>
              <ServiceIcon service="pipeline" />
              <span>
                <small>DEPLOYMENT ACTIVITY</small>
                <b>payments-production #1842</b>
              </span>
              <i />
            </header>
            {entityActions["pipeline:payments-api"] && (
              <button className="waiting" onClick={() => openExternalObject("pipeline:payments-api")}>
                <span>{pipelineRetryAudit?.time ?? "Recorded"}</span>
                <b>Retry #1843 running</b>
                <small>Verify stage · new execution linked</small>
              </button>
            )}
            {releaseWorksets[0].events.map(([time, label, detail]) => (
              <button
                className={
                  label.includes("failed")
                    ? "failed"
                    : label.includes("not started")
                      ? "waiting"
                      : label.includes("passed") || label.includes("ready")
                        ? "passed"
                        : ""
                }
                key={`${time}-${label}`}
                onClick={() => openExternalObject("pipeline:payments-api")}
              >
                <span>{time}</span>
                <b>{label}</b>
                <small>{detail}</small>
              </button>
            ))}
          </aside>
        </div>
      </section>
    </section>
  )
}
