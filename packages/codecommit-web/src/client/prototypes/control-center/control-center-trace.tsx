import {
  ArrowRight,
  Bot,
  Box,
  Check,
  ChevronDown,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  Play,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X
} from "lucide-react"
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react"
import type { ActionView } from "./control-center-action-panel.js"
import { type EntityLink, type Service, ServiceIcon } from "./control-center-foundation.js"
import { releaseTickets, type TraceDetail, type TraceId } from "./control-center-model.js"

const TraceNode = ({
  badge,
  className = "",
  detail,
  icon,
  id,
  meta,
  onSelect,
  selected,
  title
}: {
  readonly icon: ReactNode
  readonly id: TraceId
  readonly title: string
  readonly detail: string
  readonly meta: string
  readonly badge?: string
  readonly className?: string
  readonly selected: boolean
  readonly onSelect: (id: TraceId) => void
}) => (
  <button
    type="button"
    className={`cc-trace-node ${className}${selected ? " selected" : ""}`}
    onClick={() => onSelect(id)}
  >
    <header>
      {icon}
      <span>{meta}</span>
      {badge && <small>{badge}</small>}
      <MoreHorizontal size={14} />
    </header>
    <b>{title}</b>
    <p>{detail}</p>
  </button>
)

interface ReleaseGraphProps {
  readonly fixesApplied: boolean
  readonly inspectTrace: (trace: TraceId) => void
  readonly openMetric: (name: string, trace: TraceId) => void
  readonly relationFilter: boolean
  readonly selectedTicket: number
  readonly selectedTrace: TraceId
  readonly setActionView: Dispatch<SetStateAction<ActionView | null>>
  readonly setNotice: Dispatch<SetStateAction<string | null>>
  readonly setRelationFilter: Dispatch<SetStateAction<boolean>>
  readonly setSelectedTicket: Dispatch<SetStateAction<number>>
  readonly setSelectedTrace: Dispatch<SetStateAction<TraceId>>
  readonly setStatusFilter: Dispatch<SetStateAction<boolean>>
  readonly statusFilter: boolean
}

export function ReleaseGraph({
  fixesApplied,
  inspectTrace,
  openMetric,
  relationFilter,
  selectedTicket,
  selectedTrace,
  setActionView,
  setNotice,
  setRelationFilter,
  setSelectedTicket,
  setSelectedTrace,
  setStatusFilter,
  statusFilter
}: ReleaseGraphProps) {
  return (
    <>
      <div className="cc-canvas-toolbar">
        <button className={relationFilter ? "active" : ""} onClick={() => setRelationFilter((value) => !value)}>
          {relationFilter ? "Direct relations" : "All relations"} <ChevronDown size={12} />
        </button>
        <button className={statusFilter ? "active" : ""} onClick={() => setStatusFilter((value) => !value)}>
          {statusFilter ? "Blocked only" : "All statuses"} <ChevronDown size={12} />
        </button>
        <i />
        <button onClick={() => setNotice("Graph fitted to the visible delivery chain")}>
          <LayoutGrid size={15} />
          Fit graph
        </button>
      </div>
      <div className="cc-trace-heading">
        <div>
          <p>RELEASE DOSSIER / PAYMENTS</p>
          <h1>
            <span>payments-api</span> v2.18.0
          </h1>
          <small>6 tickets · 2 pull requests · 13 linked objects</small>
        </div>
        <button className="cc-ship-verdict" onClick={() => setActionView("blocker")}>
          <span>SHIP</span>
          <strong>BLOCKED</strong>
          <small>
            {fixesApplied ? "1 blocker requires action" : "2 blockers require action"} <ArrowRight size={12} />
          </small>
        </button>
      </div>
      <div className="cc-trace-kpis">
        <button onClick={() => openMetric("Trace coverage", "ticket")}>
          <b>{fixesApplied ? "100%" : "88%"}</b> trace coverage
        </button>
        <button onClick={() => openMetric("Lead time", "pipeline")}>
          <b>2d 6h</b> lead time
        </button>
        <button onClick={() => openMetric("Reviews", "prOne")}>
          <b>18/18</b> reviews passed
        </button>
        <button className="risk" onClick={() => openMetric("Blockers", "failure")}>
          <b>2</b> release blockers
        </button>
      </div>
      <div className="cc-trace-canvas">
        <div className="cc-trace-lanes">
          <span>
            <b>01</b>WORK
          </span>
          <span>
            <b>02</b>CODE
          </span>
          <span>
            <b>03</b>RELEASE
          </span>
          <span>
            <b>04</b>PIPELINE
          </span>
          <span>
            <b>05</b>DEPLOY
          </span>
        </div>
        <svg className="cc-trace-lines" viewBox="0 0 930 480" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="trace-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0L8 4L0 8Z" />
            </marker>
          </defs>
          <path d="M170 77 C190 77 190 132 210 132" />
          <path d="M170 117 C190 117 190 272 210 272" />
          <path d="M170 157 C190 157 190 132 210 132" />
          <path d="M170 217 C190 217 190 132 210 132" />
          <path d="M170 257 C190 257 190 272 210 272" />
          <path className="missing" d="M170 297 C275 297 300 232 400 232" />
          <path d="M360 132 C380 132 380 202 400 202" />
          <path d="M360 272 C380 272 380 202 400 202" />
          <path d="M550 202 L590 202" />
          <path d="M740 202 C750 202 750 132 760 132" />
          <path className="failed" d="M740 202 C750 202 750 272 760 272" />
          <path className="dotted" d="M170 392 C280 392 300 244 400 244" />
        </svg>
        <div className="cc-ticket-group">
          <header>
            <ServiceIcon service="jira" />
            <span>6 JIRA TICKETS</span>
            <small>5 linked · 1 missing</small>
          </header>
          {releaseTickets.map((item, index) => (
            <button
              key={item.key}
              className={`${item.tone}${selectedTrace === "ticket" && selectedTicket === index ? " selected" : ""}`}
              onClick={() => {
                setSelectedTicket(index)
                inspectTrace("ticket")
              }}
            >
              <span>
                <b>{item.key}</b>
                <small>{item.title}</small>
              </span>
              <em>
                {item.tone === "done" ? (
                  <Check size={11} />
                ) : item.tone === "missing" ? (
                  <Link2 size={11} />
                ) : (
                  <TriangleAlert size={11} />
                )}
              </em>
            </button>
          ))}
        </div>
        <TraceNode
          id="prOne"
          selected={selectedTrace === "prOne"}
          onSelect={inspectTrace}
          className="pr-one"
          icon={<ServiceIcon service="code" />}
          meta="PULL REQUEST"
          badge="Merged"
          title="#284 · Audit logging"
          detail="main ← feat/audit-logs"
        />
        <TraceNode
          id="prTwo"
          selected={selectedTrace === "prTwo"}
          onSelect={inspectTrace}
          className="pr-two"
          icon={<ServiceIcon service="code" />}
          meta="PULL REQUEST"
          badge="Merged"
          title="#279 · Checkout fix"
          detail="main ← fix/checkout-flow"
        />
        <TraceNode
          id="release"
          selected={selectedTrace === "release"}
          onSelect={inspectTrace}
          className="release"
          icon={
            <span className="cc-release-icon">
              <Box size={15} />
            </span>
          }
          meta="RELEASE"
          badge="Candidate"
          title="payments-api v2.18.0"
          detail="Commit a84f9d2 · 4 changes"
        />
        <TraceNode
          id="pipeline"
          selected={selectedTrace === "pipeline"}
          onSelect={inspectTrace}
          className="pipeline"
          icon={<ServiceIcon service="pipeline" />}
          meta="CODEPIPELINE"
          badge="Running"
          title="payments-production"
          detail="Run #1842 · stage 3 of 5"
        />
        <TraceNode
          id="deploy"
          selected={selectedTrace === "deploy"}
          onSelect={inspectTrace}
          className="deploy"
          icon={
            <span className="cc-release-icon green">
              <Play size={14} />
            </span>
          }
          meta="DEPLOYMENT"
          badge="Waiting"
          title="Production · eu-west-1"
          detail="Approval gate · Maya Chen"
        />
        <TraceNode
          id="failure"
          selected={selectedTrace === "failure"}
          onSelect={inspectTrace}
          className="failure"
          icon={
            <span className="cc-release-icon red">
              <X size={14} />
            </span>
          }
          meta="TEST RUN"
          badge="Failed"
          title="Integration tests"
          detail="3 failures · checkout-flow"
        />
        <TraceNode
          id="time"
          selected={selectedTrace === "time"}
          onSelect={inspectTrace}
          className="time"
          icon={<ServiceIcon service="clockify" />}
          meta="CLOCKIFY"
          badge="3h 45m"
          title="Implementation time"
          detail="Alex + Maya · linked to OPS-412"
        />
        <button className="cc-relation-label ticket-pr" onClick={() => setSelectedTrace("prOne")}>
          <Link2 size={10} />5 implemented by
        </button>
        <button className="cc-relation-label pr-release" onClick={() => setSelectedTrace("release")}>
          <Link2 size={10} />
          included in
        </button>
        <button className="cc-relation-label release-pipe" onClick={() => setSelectedTrace("pipeline")}>
          <Link2 size={10} />
          built by
        </button>
        <button className="cc-relation-label time-link" onClick={() => setSelectedTrace("time")}>
          <Link2 size={10} />
          time supports
        </button>
        <button
          className="cc-relation-label missing-link"
          onClick={() => {
            setSelectedTicket(5)
            setSelectedTrace("ticket")
          }}
        >
          <TriangleAlert size={10} />1 missing PR
        </button>
        <button className="cc-relation-label pipe-deploy" onClick={() => setSelectedTrace("deploy")}>
          <Link2 size={10} />
          deploys to
        </button>
        <button className="cc-relation-label pipe-failure" onClick={() => setSelectedTrace("failure")}>
          <Link2 size={10} />
          fails at
        </button>
      </div>
    </>
  )
}

interface TraceInspectorProps {
  readonly fixesApplied: boolean
  readonly inspectorCloseRef: RefObject<HTMLButtonElement | null>
  readonly inspectorMode: "agent" | "object"
  readonly inspectorOpen: boolean
  readonly inspectorRef: RefObject<HTMLElement | null>
  readonly inspectorRelationships: ReadonlyArray<EntityLink>
  readonly navigate: (target: "release") => void
  readonly openExternalObject: (entityId: string) => void
  readonly selected: TraceDetail
  readonly selectedTicket: number
  readonly selectedTrace: TraceId
  readonly setActionView: Dispatch<SetStateAction<ActionView | null>>
  readonly setConnectionService: Dispatch<SetStateAction<Service | null>>
  readonly setInspectorMode: Dispatch<SetStateAction<"agent" | "object">>
  readonly setInspectorOpen: Dispatch<SetStateAction<boolean>>
  readonly setSelectedTicket: Dispatch<SetStateAction<number>>
  readonly inspectTrace: (trace: TraceId) => void
}

export function TraceInspector({
  fixesApplied,
  inspectTrace,
  inspectorCloseRef,
  inspectorMode,
  inspectorOpen,
  inspectorRef,
  inspectorRelationships,
  navigate,
  openExternalObject,
  selected,
  selectedTicket,
  selectedTrace,
  setActionView,
  setConnectionService,
  setInspectorMode,
  setInspectorOpen,
  setSelectedTicket
}: TraceInspectorProps) {
  return (
    <>
      {inspectorOpen && (
        <aside
          ref={inspectorRef}
          className="cc-object-detail"
          role="dialog"
          aria-modal="false"
          aria-label={inspectorMode === "agent" ? "Release Guardian inspector" : `${selected.title} inspector`}
        >
          <header className="cc-inspector-tabs">
            <div>
              <button
                aria-pressed={inspectorMode === "agent"}
                className={inspectorMode === "agent" ? "active" : ""}
                onClick={() => setInspectorMode("agent")}
              >
                <Bot size={13} />
                Agent
              </button>
              <button
                aria-pressed={inspectorMode === "object"}
                className={inspectorMode === "object" ? "active" : ""}
                onClick={() => setInspectorMode("object")}
              >
                <Box size={13} />
                Object
              </button>
            </div>
            <button ref={inspectorCloseRef} aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
              <X size={16} />
            </button>
          </header>
          {inspectorMode === "agent" ? (
            <div className="cc-agent-inspector">
              <section className="cc-agent-state">
                <span className="cc-agent-avatar violet">
                  <Bot size={16} />
                </span>
                <div>
                  <b>Release Guardian</b>
                  <small>
                    <i />
                    Watching this release
                  </small>
                </div>
              </section>
              <section className="cc-agent-verdict">
                <small>SHIP DECISION</small>
                <h2>Not ready</h2>
                <p>
                  {fixesApplied
                    ? "I found one test blocker. The trace is complete at 16/16."
                    : "I found two blockers and one trace gap. Everything else is verified."}
                </p>
              </section>
              <section className="cc-agent-findings">
                <button
                  onClick={() => {
                    inspectTrace("failure")
                    setActionView("blocker")
                  }}
                >
                  <span className="bad">
                    <X size={13} />
                  </span>
                  <div>
                    <b>Integration tests failed</b>
                    <small>3 failures · likely PR #279</small>
                  </div>
                  <ArrowRight size={12} />
                </button>
                {!fixesApplied && (
                  <button
                    onClick={() => {
                      setSelectedTicket(0)
                      inspectTrace("ticket")
                    }}
                  >
                    <span className="warn">
                      <TriangleAlert size={13} />
                    </span>
                    <div>
                      <b>Approval is missing</b>
                      <small>OPS-412 · Maya Chen</small>
                    </div>
                    <ArrowRight size={12} />
                  </button>
                )}
                {!fixesApplied && (
                  <button
                    onClick={() => {
                      setSelectedTicket(5)
                      inspectTrace("ticket")
                    }}
                  >
                    <span className="warn">
                      <Link2 size={13} />
                    </span>
                    <div>
                      <b>Ticket has no PR</b>
                      <small>PAY-119 · trace gap</small>
                    </div>
                    <ArrowRight size={12} />
                  </button>
                )}
              </section>
              <section className="cc-agent-evidence">
                <ShieldCheck size={14} />
                <div>
                  <b>{fixesApplied ? "16 of 16" : "14 of 16"} relationships verified</b>
                  <small>Jira, CodeCommit, CodePipeline, Clockify</small>
                </div>
              </section>
              <footer>
                <button onClick={() => setActionView("agent")}>
                  <Sparkles size={13} />
                  Ask Release Guardian
                </button>
                <button className="cc-primary" onClick={() => setActionView("blocker")}>
                  Resolve blockers
                </button>
              </footer>
            </div>
          ) : (
            <>
              <div className="cc-object-title">
                <span className={`cc-object-kind ${selectedTrace}`}>
                  <Link2 size={16} />
                </span>
                <div>
                  <h2>{selected.title}</h2>
                  <p>{selected.status}</p>
                </div>
              </div>
              <p className="cc-object-summary">{selected.summary}</p>
              <section className="cc-readiness">
                <div>
                  <span>Delivery readiness</span>
                  <b>{selectedTrace === "release" ? "75%" : selectedTrace === "failure" ? "24%" : "Verified"}</b>
                </div>
                <i>
                  <span
                    style={{
                      width: selectedTrace === "failure" ? "24%" : selectedTrace === "release" ? "75%" : "100%"
                    }}
                  />
                </i>
              </section>
              <section className="cc-detail-section">
                <h3>Properties</h3>
                <dl>
                  {selected.properties.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section className="cc-detail-section">
                <h3>
                  Relationships <span>{inspectorRelationships.length}</span>
                </h3>
                <div className="cc-detail-relations">
                  {inspectorRelationships.map((relationship) => (
                    <button
                      key={relationship.relation + relationship.label}
                      onClick={() =>
                        relationship.targetId ? openExternalObject(relationship.targetId) : navigate("release")
                      }
                    >
                      <Link2 size={12} />
                      <span>
                        <small>{relationship.relation}</small>
                        <b>{relationship.label}</b>
                      </span>
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </div>
              </section>
              <section className="cc-detail-section">
                <h3>Recent activity</h3>
                <ol>
                  {selected.activity.map((event, index) => (
                    <li key={event}>
                      <i className={index === 0 ? "latest" : ""} />
                      <span>
                        {event}
                        <small>{index === 0 ? "18 min ago" : index === 1 ? "42 min ago" : "2 hr ago"}</small>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
              <footer>
                <button
                  onClick={() => {
                    if (selectedTrace === "release") {
                      setConnectionService(null)
                      setActionView("source")
                      return
                    }
                    setInspectorOpen(false)
                    openExternalObject(
                      selectedTrace === "ticket"
                        ? `jira:${releaseTickets[selectedTicket]!.key}`
                        : selectedTrace === "prOne"
                          ? "pr:payments-api:284"
                          : selectedTrace === "prTwo"
                            ? "pr:payments-api:279"
                            : selectedTrace === "time"
                              ? "clockify:payments-rollup"
                              : "pipeline:payments-api"
                    )
                  }}
                >
                  {selectedTrace === "release" ? "Open in source" : "Open full view"}
                </button>
                <button className="cc-primary" onClick={() => setActionView("agent")}>
                  <Sparkles size={13} />
                  Ask about this
                </button>
              </footer>
            </>
          )}
        </aside>
      )}
    </>
  )
}
