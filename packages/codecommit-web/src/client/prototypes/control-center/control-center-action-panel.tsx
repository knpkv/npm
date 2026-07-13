import {
  Activity,
  ArrowRight,
  Bot,
  Box,
  Braces,
  Check,
  GitBranch,
  Link2,
  MessageSquareText,
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
  X
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Service, ServiceIcon } from "./control-center-foundation.js"
import type { TraceDetail } from "./control-center-model.js"
import { releasePortfolio } from "./control-center-model.js"

export type ActionView =
  | "account"
  | "agent"
  | "analytics"
  | "blocker"
  | "export"
  | "linkPr"
  | "newTrace"
  | "object"
  | "review"
  | "share"
  | "source"
export type AgentScope = "investigation" | "portfolio" | "release" | "wip"
export type ApprovalState = "approved" | "not-requested" | "recorded" | "requested"

type SourceTab = "audit" | "overview" | "raw"

const connectionTitles: Record<Service, string> = {
  jira: "Jira Cloud",
  confluence: "Confluence",
  code: "AWS CodeCommit",
  pipeline: "AWS CodePipeline",
  clockify: "Clockify"
}

const connectionEndpoints: Record<Service, string> = {
  jira: "engineering.atlassian.net",
  confluence: "engineering.atlassian.net/wiki",
  code: "eu-west-1 / payments-api",
  pipeline: "eu-west-1 / payments-production",
  clockify: "Engineering workspace"
}

const connectionEvidence: Record<Service, string> = {
  jira: "6 release issues · webhooks active",
  confluence: "RUN-61 verified · 4 revisions",
  code: "3 pull requests · signatures verified",
  pipeline: "Run #1842 · logs retained 90 days",
  clockify: "18h 20m · 6 contributors"
}

const sourceTabs: ReadonlyArray<SourceTab> = ["overview", "raw", "audit"]
const prCandidates: ReadonlyArray<readonly [string, string, string, string]> = [
  ["#301", "feat/refund-telemetry", "Maya Chen · 4 commits · 18 checks", "96%"]
]

interface FocusTarget {
  readonly focus: () => void
}

const hasFocus = (candidate: Element | null): candidate is Element & FocusTarget =>
  candidate != null && "focus" in candidate && typeof candidate.focus === "function"

const activeElement = (): FocusTarget | null => (hasFocus(document.activeElement) ? document.activeElement : null)

const hasActionFooter = (view: ActionView): boolean =>
  view !== "account" && view !== "analytics" && view !== "object" && view !== "source"

export function ActionViewPanel({
  agentScope,
  approvalState,
  connectionService,
  fixesApplied,
  linkedPr,
  metric,
  onAdvanceApproval,
  onApplyFixes,
  onApplyRepair,
  onClose,
  onComplete,
  onRequestLink,
  onStagePr,
  portfolioContext,
  repairApplied,
  repairRelationshipApplied,
  repairReleaseIndex,
  repairRunbookApplied,
  repairTargetPrNumber,
  selected,
  view
}: {
  readonly view: ActionView
  readonly agentScope: AgentScope
  readonly approvalState: ApprovalState
  readonly connectionService: Service | null
  readonly fixesApplied: boolean
  readonly linkedPr: string | null
  readonly metric: string
  readonly portfolioContext: { readonly active: number; readonly attention: number }
  readonly onAdvanceApproval: () => void
  readonly onApplyFixes: () => void
  readonly onApplyRepair: (selection: { readonly relationship: boolean; readonly runbook: boolean }) => void
  readonly onRequestLink: () => void
  readonly selected: TraceDetail
  readonly onStagePr: (pr: string | null) => void
  readonly repairApplied: boolean
  readonly repairRelationshipApplied: boolean
  readonly repairReleaseIndex: number
  readonly repairRunbookApplied: boolean
  readonly repairTargetPrNumber: string
  readonly onClose: () => void
  readonly onComplete: (message: string) => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [sourceKind, setSourceKind] = useState<"issue" | "pr" | "release">("issue")
  const [resolution, setResolution] = useState<"diagnose" | "revert" | "assign">("diagnose")
  const [sourceTab, setSourceTab] = useState<SourceTab>("overview")
  const [linkCopied, setLinkCopied] = useState(false)
  const [prCandidate, setPrCandidate] = useState<string | null>(linkedPr)
  const [repairSelection, setRepairSelection] = useState(repairRelationshipApplied)
  const [repairRunbookSelection, setRepairRunbookSelection] = useState(repairRunbookApplied)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<FocusTarget | null>(null)
  const repairRelease = releasePortfolio[repairReleaseIndex] ?? releasePortfolio[0]
  const titles: Record<ActionView, readonly [string, string]> = {
    account: ["Workspace & account", "CONTROL CENTER"],
    agent: [
      agentScope === "portfolio"
        ? "Ask Release Guardian"
        : agentScope === "wip"
          ? "Guide OPS-428"
          : agentScope === "investigation"
            ? "Investigate test run #1842"
            : "Delegate to an agent",
      agentScope === "portfolio"
        ? "PORTFOLIO · 6 RELEASES"
        : agentScope === "wip"
          ? "ACTIVE WORK · OPS-428"
          : agentScope === "investigation"
            ? "FAILURE INVESTIGATION"
            : "AGENT WORKSPACE"
    ],
    analytics: [`${metric} analysis`, "DELIVERY INTELLIGENCE"],
    blocker: ["Resolve release blockers", "GUIDED WORKFLOW"],
    export: ["Export activity timeline", "EXPORT"],
    linkPr: ["Link PAY-119 to code", "RELATIONSHIP REPAIR"],
    newTrace: ["Create delivery trace", "NEW TRACE"],
    object: ["Object actions", selected.type.toUpperCase()],
    review: [
      repairReleaseIndex === 0 ? "Review trace completeness" : `Repair ${repairRelease.service} trace`,
      repairReleaseIndex === 0 ? "AGENT FINDINGS" : "SCOPED TRACE REPAIR"
    ],
    share: ["Share delivery trace", "COLLABORATION"],
    source: [
      connectionService ? connectionTitles[connectionService] : selected.title,
      connectionService ? "CONNECTED SERVICE" : "SOURCE RECORD"
    ]
  }
  const [title, eyebrow] = titles[view]
  const verifiedLinks = fixesApplied ? 16 : 14
  const traceCoverage = Math.round((verifiedLinks / 16) * 100)
  const remainingRepairGaps =
    repairReleaseIndex === 5
      ? Number(!repairRelationshipApplied) + Number(!repairRunbookApplied)
      : Number(!repairRelationshipApplied)
  useEffect(() => {
    if (view === "linkPr") setPrCandidate(linkedPr)
  }, [linkedPr, view])
  useEffect(() => {
    setRepairSelection(repairRelationshipApplied)
    setRepairRunbookSelection(repairRunbookApplied)
  }, [repairRelationshipApplied, repairReleaseIndex, repairRunbookApplied])
  useEffect(() => {
    previousFocusRef.current = activeElement()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
          ) ?? []
        ).filter((element) => !element.hasAttribute("hidden"))
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onClose])
  return (
    <div
      className="cc-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section ref={dialogRef} className={`cc-action-view ${view}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <small>{eyebrow}</small>
            <h2>{title}</h2>
          </div>
          <button ref={closeButtonRef} aria-label="Close view" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="cc-action-body">
          {view === "share" && (
            <>
              <p className="cc-view-intro">
                Give teammates live access to this trace. Changes and agent findings stay synchronized.
              </p>
              <label className="cc-form-label">
                People or teams
                <div className="cc-combo">
                  <Search size={14} />
                  <input placeholder="Search workspace members…" />
                </div>
              </label>
              <div className="cc-access-row">
                <span>MC</span>
                <div>
                  <b>Maya Chen</b>
                  <small>maya@example.com</small>
                </div>
                <select defaultValue="edit">
                  <option value="edit">Can edit</option>
                  <option value="view">Can view</option>
                </select>
              </div>
              <div className="cc-access-row">
                <span>PE</span>
                <div>
                  <b>Payments Engineering</b>
                  <small>8 members</small>
                </div>
                <select defaultValue="view">
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </select>
              </div>
              <label className="cc-form-label">
                Shareable link
                <div className="cc-copy-field">
                  <input readOnly value="control.local/trace/payments-v2.18" />
                  <button
                    aria-live="polite"
                    onClick={() => {
                      setLinkCopied(true)
                      window.setTimeout(() => setLinkCopied(false), 1800)
                    }}
                  >
                    {linkCopied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </label>
            </>
          )}
          {view === "agent" && (
            <>
              <p className="cc-view-intro">
                {agentScope === "portfolio"
                  ? "Release Guardian will compare all six releases, prioritize attention, and propose cross-release actions."
                  : agentScope === "wip"
                    ? "Scoped to OPS-428, six Jira items, PRs #291/#293, three preview executions, pending review, and RUN-70."
                    : agentScope === "investigation"
                      ? "Scoped to run #1842, three failures, suspected PR #279, PAY-118, OPS-419, and the blocked production deployment."
                      : "The agent receives the selected object, its connected evidence, and your workspace policies."}
              </p>
              <div className="cc-agent-choice selected">
                <span className="cc-agent-avatar violet">
                  <Bot size={16} />
                </span>
                <div>
                  <b>Release Guardian</b>
                  <small>Release readiness, failures, approvals</small>
                </div>
                <Check size={15} />
              </div>
              <label className="cc-form-label">
                Task
                <textarea
                  defaultValue={
                    agentScope === "portfolio"
                      ? "Compare readiness across all releases. Prioritize blockers, trace gaps, and the safest next actions."
                      : agentScope === "wip"
                        ? "Prepare PR #293 for review, verify preview evidence, and propose the next safe action for OPS-428."
                        : agentScope === "investigation"
                          ? "Diagnose run #1842, verify PR #279 impact on PAY-118 and OPS-419, and protect production."
                          : `Investigate ${selected.title}, explain the risk, and propose the safest next action.`
                  }
                  rows={4}
                />
              </label>
              <div className="cc-agent-context">
                <b>Context included</b>
                <span>
                  <Check size={12} />
                  {agentScope === "portfolio"
                    ? "6 releases · 36 Jira items"
                    : agentScope === "wip"
                      ? "OPS-428 · 6 Jira items"
                      : agentScope === "investigation"
                        ? "Test run #1842 · 3 failures"
                        : selected.title}
                </span>
                <span>
                  <Check size={12} />
                  {agentScope === "portfolio"
                    ? `${portfolioContext.attention} attention releases · ${portfolioContext.active} active delivery states`
                    : agentScope === "wip"
                      ? "PR #291 · PR #293 · 3 previews"
                      : agentScope === "investigation"
                        ? "PR #279 · PAY-118 · OPS-419"
                        : "3 direct relationships"}
                </span>
                <span>
                  <Check size={12} />
                  {agentScope === "investigation"
                    ? "Blocked production deployment"
                    : agentScope === "wip"
                      ? "Pending review · Confluence RUN-70"
                      : "Pipeline logs and Jira history"}
                </span>
              </div>
              <label className="cc-check">
                <input type="checkbox" defaultChecked />
                Require my approval before external changes
              </label>
            </>
          )}
          {view === "newTrace" && (
            <>
              <p className="cc-view-intro">
                Choose an anchor and Control Center will discover related work, code, builds, deployments, and time.
              </p>
              <div className="cc-source-grid">
                <button
                  aria-pressed={sourceKind === "issue"}
                  className={sourceKind === "issue" ? "selected" : ""}
                  onClick={() => setSourceKind("issue")}
                >
                  <ServiceIcon service="jira" />
                  <b>Jira issue</b>
                  <small>Start from work</small>
                </button>
                <button
                  aria-pressed={sourceKind === "pr"}
                  className={sourceKind === "pr" ? "selected" : ""}
                  onClick={() => setSourceKind("pr")}
                >
                  <ServiceIcon service="code" />
                  <b>Pull request</b>
                  <small>Start from code</small>
                </button>
                <button
                  aria-pressed={sourceKind === "release"}
                  className={sourceKind === "release" ? "selected" : ""}
                  onClick={() => setSourceKind("release")}
                >
                  <span className="cc-release-icon">
                    <Box size={15} />
                  </span>
                  <b>Release</b>
                  <small>Start from version</small>
                </button>
              </div>
              <label className="cc-form-label">
                {sourceKind === "issue" ? "Jira issue key" : sourceKind === "pr" ? "Pull request" : "Release version"}
                <div className="cc-combo">
                  {sourceKind === "issue" ? (
                    <ServiceIcon service="jira" />
                  ) : sourceKind === "pr" ? (
                    <ServiceIcon service="code" />
                  ) : (
                    <span className="cc-release-icon">
                      <Box size={15} />
                    </span>
                  )}
                  <input
                    key={sourceKind}
                    defaultValue={
                      sourceKind === "issue"
                        ? "OPS-412"
                        : sourceKind === "pr"
                          ? "payments-api / PR #284"
                          : "payments-api / 2.18.0"
                    }
                  />
                </div>
              </label>
              <label className="cc-form-label">
                Discovery depth
                <select defaultValue="full">
                  <option value="full">Full delivery chain</option>
                  <option value="direct">Direct relationships only</option>
                </select>
              </label>
              <div className="cc-discovery-preview">
                <b>Preview</b>
                <span>1 ticket</span>
                <ArrowRight size={12} />
                <span>2 PRs</span>
                <ArrowRight size={12} />
                <span>1 release</span>
                <ArrowRight size={12} />
                <span>2 executions</span>
              </div>
            </>
          )}
          {view === "linkPr" && (
            <>
              <p className="cc-view-intro">
                Choose the CodeCommit pull request that implements PAY-119. The relationship will be staged for review
                before canonical data changes.
              </p>
              <label className="cc-form-label">
                Search CodeCommit
                <div className="cc-combo">
                  <Search size={14} />
                  <input defaultValue="refund telemetry" />
                </div>
              </label>
              <div className="cc-pr-candidates" role="radiogroup" aria-label="Pull request candidates">
                {prCandidates.map(([pr, branch, detail, confidence]) => (
                  <button
                    role="radio"
                    aria-checked={prCandidate === pr}
                    className={prCandidate === pr ? "selected" : ""}
                    key={pr}
                    onClick={() => setPrCandidate(pr)}
                  >
                    <ServiceIcon service="code" />
                    <span>
                      <b>
                        PR {pr} · {branch}
                      </b>
                      <small>{detail}</small>
                    </span>
                    <em>{confidence}</em>
                    {prCandidate === pr && <Check size={14} />}
                  </button>
                ))}
              </div>
              {prCandidate && (
                <div className="cc-link-preview">
                  <b>Relationship preview</b>
                  <span>PAY-119 → PR {prCandidate} → payments-api 2.18.0</span>
                  <small>Projected: 6/6 Jira linked · 3 PRs · 14 linked objects</small>
                </div>
              )}
            </>
          )}
          {view === "export" && (
            <>
              <p className="cc-view-intro">
                Export the normalized delivery history with source attribution and relationship evidence.
              </p>
              <label className="cc-form-label">
                Format
                <select defaultValue="csv">
                  <option value="csv">CSV · event rows</option>
                  <option value="json">JSON · full evidence</option>
                  <option value="pdf">PDF · release report</option>
                </select>
              </label>
              <label className="cc-form-label">
                Range
                <select defaultValue="today">
                  <option value="today">12 July 2026</option>
                  <option value="two-days">11–12 July 2026</option>
                  <option value="release">Entire release</option>
                </select>
              </label>
              <label className="cc-check">
                <input type="checkbox" defaultChecked />
                Include raw source identifiers and agent actions
              </label>
            </>
          )}
          {view === "review" && repairReleaseIndex === 0 && (
            <>
              <p className="cc-view-intro">
                The agent checked identifiers, branch names, commits, timestamps, and service metadata.
              </p>
              <div className="cc-coverage-score">
                <strong>{traceCoverage}%</strong>
                <div>
                  <b>Trace coverage</b>
                  <span>{verifiedLinks} of 16 expected links verified</span>
                  <i>
                    <span style={{ width: `${traceCoverage}%` }} />
                  </i>
                </div>
              </div>
              <div className="cc-finding">
                <TriangleAlert size={15} />
                <div>
                  <b>PAY-119 has no pull request</b>
                  <p>
                    {linkedPr ? `PR ${linkedPr} selected · ready to apply` : "No canonical PR relationship recorded."}
                  </p>
                </div>
                <div className="cc-finding-actions">
                  <button disabled={fixesApplied} onClick={onRequestLink}>
                    {fixesApplied ? "Applied" : linkedPr ? "Change PR" : "Choose PR"}
                  </button>
                  {linkedPr && !fixesApplied && (
                    <button className="remove" onClick={() => onStagePr(null)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <div className="cc-finding">
                <TriangleAlert size={15} />
                <div>
                  <b>Deployment approval not attributed</b>
                  <p>
                    {approvalState === "not-requested"
                      ? "Approval has not been requested."
                      : approvalState === "requested"
                        ? "Requested from Maya Chen at 10:21."
                        : approvalState === "approved"
                          ? "Approved by Maya · source APR-8842."
                          : "Recorded in Jira as OPS-412-APR-9."}
                  </p>
                </div>
                <button disabled={approvalState === "recorded" || fixesApplied} onClick={onAdvanceApproval}>
                  {approvalState === "not-requested"
                    ? "Request"
                    : approvalState === "requested"
                      ? "Refresh"
                      : approvalState === "approved"
                        ? "Record in Jira"
                        : "Recorded"}
                </button>
              </div>
              <div className="cc-finding good">
                <Check size={15} />
                <div>
                  <b>{verifiedLinks} relationships verified</b>
                  <p>
                    {fixesApplied
                      ? "All expected evidence agrees across source systems."
                      : linkedPr && approvalState === "recorded"
                        ? "2 fixes ready to apply."
                        : "Evidence agrees across verified source systems."}
                  </p>
                </div>
              </div>
            </>
          )}
          {view === "review" && repairReleaseIndex !== 0 && (
            <>
              <p className="cc-view-intro">
                This repair is scoped only to{" "}
                <strong>
                  {repairRelease.service} {repairRelease.version}
                </strong>
                . Select the missing evidence to attach.
              </p>
              <div className="cc-blocker-summary">
                <span>
                  <Link2 size={17} />
                </span>
                <div>
                  <small>{repairRelease.service.toUpperCase()} TRACE</small>
                  <b>
                    {remainingRepairGaps} evidence gap{remainingRepairGaps === 1 ? "" : "s"}
                  </b>
                  <p>
                    {repairReleaseIndex === 5
                      ? !repairRelationshipApplied && !repairRunbookApplied
                        ? "RISK-61 needs a pull request; RUN-54 needs current rollout evidence."
                        : !repairRelationshipApplied
                          ? "RISK-61 still needs a pull request. The rollout evidence is current."
                          : !repairRunbookApplied
                            ? "RUN-54 still needs current rollout evidence. The pull request is linked."
                            : "Both evidence relationships are current."
                      : "DOC-97 needs an approved Confluence recovery runbook."}
                  </p>
                </div>
              </div>
              <div className="cc-pr-candidates" role="group" aria-label="Repair candidates">
                <button
                  aria-pressed={repairSelection}
                  className={repairSelection ? "selected" : ""}
                  disabled={repairRelationshipApplied}
                  onClick={() => setRepairSelection((selected) => !selected)}
                >
                  <ServiceIcon service={repairReleaseIndex === 5 ? "code" : "confluence"} />
                  <span>
                    <b>
                      {repairReleaseIndex === 5
                        ? `PR #${repairTargetPrNumber} · Explain score overrides`
                        : "RUN-67 · Ledger recovery guide"}
                    </b>
                    <small>
                      {repairReleaseIndex === 5
                        ? "CodeCommit · 6 commits · 14 checks"
                        : "Confluence · approved by Nina · current"}
                    </small>
                  </span>
                  <em>94%</em>
                  {repairSelection && <Check size={14} />}
                </button>
                {repairReleaseIndex === 5 && (
                  <button
                    aria-pressed={repairRunbookSelection}
                    className={repairRunbookSelection ? "selected" : ""}
                    disabled={repairRunbookApplied}
                    onClick={() => setRepairRunbookSelection((selected) => !selected)}
                  >
                    <ServiceIcon service="confluence" />
                    <span>
                      <b>RUN-54 · Risk analyst rollout guide · new revision</b>
                      <small>Confluence · proposed revision for 0.18.0 · approved by Nina</small>
                    </span>
                    <em>98%</em>
                    {repairRunbookSelection && <Check size={14} />}
                  </button>
                )}
              </div>
              {(repairSelection || repairRunbookSelection) && (
                <div className="cc-link-preview">
                  <b>Scoped relationship preview</b>
                  {repairSelection && (
                    <span>
                      {repairReleaseIndex === 5
                        ? `RISK-61 → PR #${repairTargetPrNumber} → risk-engine 0.18.0`
                        : "DOC-97 → RUN-67 → ledger-worker 3.4.0"}
                    </span>
                  )}
                  {repairReleaseIndex === 5 && repairRunbookSelection && (
                    <span>DOC-106 → RUN-54 revision → risk-engine 0.18.0</span>
                  )}
                  <small>No payments-api objects will be changed.</small>
                </div>
              )}
            </>
          )}
          {view === "blocker" && (
            <>
              <div className="cc-blocker-summary">
                <span>
                  <X size={17} />
                </span>
                <div>
                  <small>BLOCKER 1 OF 2</small>
                  <b>Integration tests failed</b>
                  <p>3 failures correlate with PR #279.</p>
                </div>
              </div>
              <div className="cc-log-snippet">
                <code>checkout-flow › confirms payment once</code>
                <span>Expected 1 request · Received 2</span>
                <small>tests/checkout/confirmation.test.ts:184</small>
              </div>
              <div className="cc-resolution-options">
                <button
                  aria-pressed={resolution === "diagnose"}
                  className={resolution === "diagnose" ? "selected" : ""}
                  onClick={() => setResolution("diagnose")}
                >
                  <Bot size={15} />
                  <div>
                    <b>Diagnose with agent</b>
                    <small>Inspect diff, tests, and logs</small>
                  </div>
                  {resolution === "diagnose" && <Check size={14} />}
                </button>
                <button
                  aria-pressed={resolution === "revert"}
                  className={resolution === "revert" ? "selected" : ""}
                  onClick={() => setResolution("revert")}
                >
                  <GitBranch size={15} />
                  <div>
                    <b>Create revert PR</b>
                    <small>Revert suspected change #279</small>
                  </div>
                  {resolution === "revert" && <Check size={14} />}
                </button>
                <button
                  aria-pressed={resolution === "assign"}
                  className={resolution === "assign" ? "selected" : ""}
                  onClick={() => setResolution("assign")}
                >
                  <MessageSquareText size={15} />
                  <div>
                    <b>Assign to author</b>
                    <small>Notify Maya with evidence</small>
                  </div>
                  {resolution === "assign" && <Check size={14} />}
                </button>
              </div>
              <label className="cc-check">
                <input type="checkbox" defaultChecked />
                Post progress back to OPS-412
              </label>
            </>
          )}
          {view === "source" && (
            <>
              {connectionService ? (
                <div className="cc-connection-detail">
                  <ServiceIcon service={connectionService} />
                  <div>
                    <small>ENDPOINT</small>
                    <b>{connectionEndpoints[connectionService]}</b>
                  </div>
                  <div>
                    <small>SYNC STATE</small>
                    <b>Connected · refreshed 18 seconds ago</b>
                  </div>
                  <div>
                    <small>EVIDENCE</small>
                    <b>{connectionEvidence[connectionService]}</b>
                  </div>
                  <div className="cc-object-actions compact">
                    <button onClick={() => onComplete(`${connectionService} connection refreshed`)}>
                      <Activity size={15} />
                      <span>
                        <b>Refresh connection</b>
                        <small>Fetch current configuration and evidence</small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                    <button onClick={() => onComplete(`${connectionService} permissions opened`)}>
                      <ShieldCheck size={15} />
                      <span>
                        <b>Manage permissions</b>
                        <small>Scopes, webhooks, and agent access</small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    className="cc-source-tabs"
                    role="tablist"
                    aria-label="Source record views"
                    onKeyDown={(event) => {
                      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                      event.preventDefault()
                      const currentIndex = sourceTabs.indexOf(sourceTab)
                      const nextIndex =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? sourceTabs.length - 1
                            : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + sourceTabs.length) %
                              sourceTabs.length
                      const nextTab = sourceTabs[nextIndex] ?? sourceTab
                      setSourceTab(nextTab)
                      document.getElementById(`source-tab-${nextTab}`)?.focus()
                    }}
                  >
                    <button
                      id="source-tab-overview"
                      role="tab"
                      aria-selected={sourceTab === "overview"}
                      aria-controls="source-panel-overview"
                      tabIndex={sourceTab === "overview" ? 0 : -1}
                      className={sourceTab === "overview" ? "active" : ""}
                      onClick={() => setSourceTab("overview")}
                    >
                      Overview
                    </button>
                    <button
                      id="source-tab-raw"
                      role="tab"
                      aria-selected={sourceTab === "raw"}
                      aria-controls="source-panel-raw"
                      tabIndex={sourceTab === "raw" ? 0 : -1}
                      className={sourceTab === "raw" ? "active" : ""}
                      onClick={() => setSourceTab("raw")}
                    >
                      Raw payload
                    </button>
                    <button
                      id="source-tab-audit"
                      role="tab"
                      aria-selected={sourceTab === "audit"}
                      aria-controls="source-panel-audit"
                      tabIndex={sourceTab === "audit" ? 0 : -1}
                      className={sourceTab === "audit" ? "active" : ""}
                      onClick={() => setSourceTab("audit")}
                    >
                      Audit
                    </button>
                  </div>
                  {sourceTab === "raw" && (
                    <pre
                      id="source-panel-raw"
                      role="tabpanel"
                      aria-labelledby="source-tab-raw"
                      className="cc-raw-payload"
                    >
                      {JSON.stringify(
                        {
                          id: "a84f9d2",
                          type: selected.type,
                          title: selected.title,
                          status: selected.status,
                          synchronizedAt: "2026-07-12T17:42:18Z"
                        },
                        null,
                        2
                      )}
                    </pre>
                  )}
                  {sourceTab === "audit" && (
                    <div
                      id="source-panel-audit"
                      role="tabpanel"
                      aria-labelledby="source-tab-audit"
                      className="cc-audit-events"
                    >
                      <p>
                        <Check size={14} />
                        <span>
                          <b>Signature verified</b>
                          <small>18 seconds ago · Control sync</small>
                        </span>
                      </p>
                      <p>
                        <Link2 size={14} />
                        <span>
                          <b>Relationship added</b>
                          <small>42 minutes ago · Release Guardian</small>
                        </span>
                      </p>
                      <p>
                        <Activity size={14} />
                        <span>
                          <b>Source refreshed</b>
                          <small>2 hours ago · AWS event</small>
                        </span>
                      </p>
                    </div>
                  )}
                  {sourceTab === "overview" && (
                    <div id="source-panel-overview" role="tabpanel" aria-labelledby="source-tab-overview">
                      <dl className="cc-source-record">
                        {selected.properties.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                        <div>
                          <dt>Canonical ID</dt>
                          <dd>
                            <code>arn:control:trace:a84f9d2</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Last synchronized</dt>
                          <dd>18 seconds ago</dd>
                        </div>
                      </dl>
                      <h3 className="cc-view-subhead">Source evidence</h3>
                      <div className="cc-evidence-row">
                        <ShieldCheck size={15} />
                        <div>
                          <b>Signature verified</b>
                          <small>Received directly from service API</small>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="cc-evidence-row">
                    <Activity size={15} />
                    <div>
                      <b>4 revisions retained</b>
                      <small>Newest change 42 minutes ago</small>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {view === "analytics" && (
            <>
              <p className="cc-view-intro">How {metric.toLowerCase()} changed across the last six payments releases.</p>
              <div className="cc-big-metric">
                <div>
                  <small>CURRENT</small>
                  <strong>
                    {metric === "Lead time"
                      ? "2d 6h"
                      : metric === "Reviews"
                        ? "18/18"
                        : metric === "Blockers"
                          ? "2"
                          : `${traceCoverage}%`}
                  </strong>
                  <span>↑ 12% better than previous release</span>
                </div>
                <div className="cc-mini-bars">
                  {[42, 58, 51, 72, 65, 82].map((height, index) => (
                    <i key={index} style={{ height: `${height}%` }} />
                  ))}
                </div>
              </div>
              <h3 className="cc-view-subhead">Contributors to this result</h3>
              <div className="cc-analysis-row">
                <ServiceIcon service="jira" />
                <div>
                  <b>Work-item linkage</b>
                  <small>4 of 5 expected tickets connected</small>
                </div>
                <strong>80%</strong>
              </div>
              <div className="cc-analysis-row">
                <ServiceIcon service="code" />
                <div>
                  <b>Code review evidence</b>
                  <small>All required reviewers and checks present</small>
                </div>
                <strong>100%</strong>
              </div>
              <div className="cc-analysis-row">
                <ServiceIcon service="pipeline" />
                <div>
                  <b>Delivery evidence</b>
                  <small>Failure prevents deployment verification</small>
                </div>
                <strong>67%</strong>
              </div>
            </>
          )}
          {view === "object" && (
            <>
              <p className="cc-view-intro">
                Manage <strong>{selected.title}</strong> and its role in this delivery trace.
              </p>
              <div className="cc-object-actions">
                <button onClick={() => onComplete("Relationship editor opened")}>
                  <Link2 size={16} />
                  <div>
                    <b>Add relationship</b>
                    <small>Connect another ticket, PR, run, or entry</small>
                  </div>
                  <ArrowRight size={14} />
                </button>
                <button onClick={() => onComplete("Source object refreshed")}>
                  <Activity size={16} />
                  <div>
                    <b>Refresh from source</b>
                    <small>Fetch the latest service state</small>
                  </div>
                  <ArrowRight size={14} />
                </button>
                <button onClick={() => onComplete("Evidence verified")}>
                  <ShieldCheck size={16} />
                  <div>
                    <b>Verify evidence</b>
                    <small>Re-run provenance checks</small>
                  </div>
                  <ArrowRight size={14} />
                </button>
                <button className="danger" onClick={() => onComplete("Object removed from this trace")}>
                  <X size={16} />
                  <div>
                    <b>Remove from trace</b>
                    <small>Keep source object unchanged</small>
                  </div>
                  <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}
          {view === "account" && (
            <>
              <div className="cc-account-card">
                <span>AK</span>
                <div>
                  <b>Alex K.</b>
                  <small>alex@example.com</small>
                </div>
                <button onClick={() => onComplete("Profile settings opened")}>Manage profile</button>
              </div>
              <h3 className="cc-view-subhead">Workspace</h3>
              <div className="cc-workspace-row">
                <span className="cc-brand-mark">
                  <Braces size={14} />
                </span>
                <div>
                  <b>Engineering</b>
                  <small>4 plugins · 3 active agents</small>
                </div>
                <Check size={14} />
              </div>
              <div className="cc-object-actions compact">
                <button onClick={() => onComplete("Workspace settings opened")}>
                  <Settings size={15} />
                  <div>
                    <b>Workspace settings</b>
                    <small>Members, plugins, permissions</small>
                  </div>
                  <ArrowRight size={13} />
                </button>
                <button onClick={() => onComplete("Agent permissions opened")}>
                  <ShieldCheck size={15} />
                  <div>
                    <b>Agent permissions</b>
                    <small>Review action boundaries</small>
                  </div>
                  <ArrowRight size={13} />
                </button>
              </div>
            </>
          )}
        </div>
        {hasActionFooter(view) && (
          <footer>
            <button onClick={onClose}>Cancel</button>
            <button
              className="cc-primary"
              disabled={
                (view === "linkPr" && !prCandidate) ||
                (view === "review" &&
                  (repairReleaseIndex === 0
                    ? !linkedPr || approvalState !== "recorded" || fixesApplied
                    : repairReleaseIndex === 5
                      ? (!(repairSelection && !repairRelationshipApplied) &&
                          !(repairRunbookSelection && !repairRunbookApplied)) ||
                        repairApplied
                      : !repairSelection || repairApplied))
              }
              onClick={() => {
                if (view === "linkPr" && prCandidate) {
                  onStagePr(prCandidate)
                  onComplete(`PR ${prCandidate} staged for PAY-119`)
                  return
                }
                if (view === "review") {
                  if (repairReleaseIndex === 0) {
                    onApplyFixes()
                    onComplete("Trace fixes applied · coverage 16/16")
                  } else {
                    onApplyRepair({
                      relationship: repairSelection && !repairRelationshipApplied,
                      runbook: repairRunbookSelection && !repairRunbookApplied
                    })
                    onComplete(`${repairRelease.service} trace repair applied`)
                  }
                  return
                }
                onComplete(
                  view === "agent"
                    ? "Agent task started"
                    : view === "blocker"
                      ? resolution === "diagnose"
                        ? "Release Guardian started diagnosing the failed tests"
                        : resolution === "revert"
                          ? "Revert pull request draft created"
                          : "Failure assigned to Maya Chen"
                      : view === "newTrace"
                        ? `Delivery trace created from ${
                            sourceKind === "issue" ? "OPS-412" : sourceKind === "pr" ? "PR #284" : "release 2.18.0"
                          }`
                        : view === "export"
                          ? "Timeline export prepared"
                          : "Sharing settings updated"
                )
              }}
            >
              {view === "agent"
                ? "Start agent"
                : view === "blocker"
                  ? "Start resolution"
                  : view === "newTrace"
                    ? "Create trace"
                    : view === "export"
                      ? "Export timeline"
                      : view === "linkPr"
                        ? "Confirm PR"
                        : view === "review"
                          ? repairReleaseIndex === 0
                            ? fixesApplied
                              ? "Fixes applied"
                              : "Apply fixes"
                            : repairApplied
                              ? "Repair applied"
                              : "Apply repair"
                          : "Save access"}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}
