import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  Braces,
  Check,
  ChevronDown,
  Clock3,
  GitBranch,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageSquareText,
  Network,
  ShieldCheck,
  Terminal,
  X
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { EntityCollaborators } from "./control-center-collaborators.js"
import { jiraEntityTabs, JiraEntityView } from "./control-center-jira-view.js"
import type { AgentCodeReview, JiraIssueState } from "./control-center-state.js"

export function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className="cc-brand">
      <span className="cc-brand-mark">
        <Braces size={17} />
      </span>
      {!compact && <span>Control Center</span>}
    </div>
  )
}

export type Service = "clockify" | "code" | "confluence" | "jira" | "pipeline"
export interface EntityLink {
  readonly kind: Service | "release"
  readonly label: string
  readonly relation: string
  readonly targetId: string | null
}
export interface EntityRecord {
  readonly action: string | null
  readonly activity: ReadonlyArray<string>
  readonly completedStatus?: string
  readonly completedVerdict: string
  readonly facts: ReadonlyArray<readonly [string, string]>
  readonly id: string
  readonly impact: string
  readonly relationships: ReadonlyArray<EntityLink>
  readonly service: Service
  readonly status: string
  readonly tabs: Readonly<Record<string, ReadonlyArray<string>>>
  readonly title: string
  readonly verdict: string
}

export type TimelineActor = "agent" | "human" | "system"
export interface WorkflowEvent {
  readonly actor: TimelineActor
  readonly label: string
  readonly sequence?: number
  readonly time: string
}

const deliveryLinkKinds: ReadonlyArray<EntityLink["kind"]> = ["jira", "code", "pipeline", "release"]

interface FocusTarget {
  readonly focus: () => void
}

const hasFocus = (candidate: Element | null): candidate is Element & FocusTarget =>
  candidate != null && "focus" in candidate && typeof candidate.focus === "function"

const activeElement = (): FocusTarget | null => (hasFocus(document.activeElement) ? document.activeElement : null)

export function ServiceIcon({ service }: { readonly service: Service }) {
  const icons = { clockify: Clock3, code: GitBranch, confluence: MessageSquareText, jira: ListTodo, pipeline: Network }
  const labels: Record<Service, string> = {
    clockify: "Clockify",
    code: "AWS CodeCommit",
    confluence: "Confluence",
    jira: "Jira",
    pipeline: "AWS CodePipeline"
  }
  const Icon = icons[service]
  return (
    <span className={`cc-service-icon ${service}`} aria-hidden="true" title={labels[service]}>
      <Icon size={16} />
    </span>
  )
}

export function ServiceEntityPage({
  actionComplete,
  agentReview,
  backLabel,
  jiraIssueState,
  object,
  onAsk,
  onBack,
  onJiraIssueStateChange,
  onNotice,
  onOpenAgentReview,
  onOpenRelated,
  onRequestAction
}: {
  readonly actionComplete: boolean
  readonly agentReview?: AgentCodeReview
  readonly backLabel: string
  readonly jiraIssueState?: JiraIssueState
  readonly object: EntityRecord
  readonly onAsk: () => void
  readonly onBack: () => void
  readonly onNotice: (message: string) => void
  readonly onOpenAgentReview: () => void
  readonly onOpenRelated: (targetId: string | null) => void
  readonly onRequestAction: () => void
  readonly onJiraIssueStateChange: (state: JiraIssueState) => void
}) {
  const [tab, setTab] = useState(
    object.service === "code"
      ? "Files"
      : object.service === "pipeline"
        ? "Live execution"
        : object.service === "jira"
          ? "Description"
          : "Primary"
  )
  const labels = {
    clockify: object.id.includes("rollup") ? "CLOCKIFY · WORK ROLL-UP" : "CLOCKIFY · TIME ENTRY",
    code: "AWS CODECOMMIT · PULL REQUEST",
    confluence: "CONFLUENCE · PAGE",
    jira: "JIRA · ISSUE",
    pipeline: "AWS CODEPIPELINE · EXECUTION"
  }
  const serviceName = {
    clockify: "Clockify",
    code: "AWS CodeCommit",
    confluence: "Confluence",
    jira: "Jira",
    pipeline: "AWS CodePipeline"
  }[object.service]
  const tabs = object.service === "jira" ? jiraEntityTabs : Object.keys(object.tabs)
  const agentVerdict =
    object.service === "code" && agentReview
      ? agentReview.status === "approved"
        ? "Approved"
        : agentReview.status === "changes-requested"
          ? "Changes requested"
          : agentReview.status === "completed"
            ? "Findings ready"
            : "Agent reviewing"
      : null
  const jiraTab = jiraEntityTabs.find((candidate) => candidate === tab) ?? "Description"
  const mainLinks = deliveryLinkKinds
    .map((kind) => {
      if (kind === object.service) {
        return { kind, label: object.title, relation: "CURRENT OBJECT", targetId: object.id }
      }
      return object.relationships.find((relationship) => relationship.kind === kind) ?? null
    })
    .filter((relationship): relationship is EntityLink => relationship != null)
  return (
    <section className={`cc-entity-page ${object.service}`}>
      <button className="cc-entity-back" onClick={onBack}>
        <ArrowLeft size={15} />
        {backLabel}
      </button>
      <header className="cc-entity-hero">
        <div>
          <span>
            <ServiceIcon service={object.service} />
            {labels[object.service]}
          </span>
          <h1>{agentVerdict ?? (actionComplete ? object.completedVerdict : object.verdict)}</h1>
          <p>{object.title}</p>
          <small>
            <ShieldCheck size={13} />
            Release Guardian checked 14 facts · 18 seconds ago
          </small>
          {agentReview?.status === "approved" && (
            <small className="cc-agent-approval-evidence">
              <Check size={13} />
              Alex K. approved the agent findings · sandbox evidence retained
            </small>
          )}
        </div>
        <div className="cc-entity-hero-actions">
          {object.service === "code" && (
            <button className="agent-review" onClick={onOpenAgentReview}>
              <Bot size={17} />
              {agentReview?.status === "approved"
                ? "Approved by agent review"
                : agentReview?.status === "changes-requested"
                  ? "Changes requested"
                  : agentReview?.status === "completed"
                    ? "Findings ready"
                    : agentReview
                      ? "Agent reviewing"
                      : "Ask agent to review"}
            </button>
          )}
          {object.action && (
            <button disabled={actionComplete} onClick={onRequestAction}>
              {actionComplete ? "Human review requested" : object.action}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </header>
      <EntityCollaborators entity={object} />
      <div className="cc-entity-chain" aria-label="Delivery relationship chain">
        {mainLinks.map((relationship, index) => (
          <button
            className={relationship.targetId === object.id ? "current" : ""}
            key={`${relationship.kind}-${relationship.label}`}
            onClick={() => relationship.targetId !== object.id && onOpenRelated(relationship.targetId)}
          >
            {relationship.kind === "release" ? (
              <span className="cc-release-icon">
                <Box size={16} />
              </span>
            ) : (
              <ServiceIcon service={relationship.kind} />
            )}
            <span>
              <small>{relationship.relation}</small>
              <b>{relationship.label}</b>
            </span>
            {index < mainLinks.length - 1 && <ArrowRight size={14} />}
          </button>
        ))}
      </div>
      {(object.service === "confluence" || object.service === "clockify") && (
        <div className="cc-entity-support">
          <button className="current">
            <ServiceIcon service={object.service} />
            <span>
              <small>{object.service === "confluence" ? "RELEASE EVIDENCE" : "WORK EVIDENCE"}</small>
              <b>{object.title}</b>
            </span>
            <Check size={14} />
          </button>
        </div>
      )}
      <div className="cc-entity-layout">
        <article className="cc-entity-native">
          <header>
            <h2>
              {object.service === "code"
                ? "Change"
                : object.service === "jira"
                  ? "Work definition"
                  : object.service === "confluence"
                    ? "Runbook"
                    : object.service === "pipeline"
                      ? "Live execution"
                      : "Time record"}
            </h2>
            <nav>
              {tabs.map((item) => (
                <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
                  {item}
                </button>
              ))}
            </nav>
          </header>
          {object.service === "code" && (
            <div className="cc-pr-native">
              <div className="cc-native-summary">
                <b>
                  {object.facts.find(([label]) => label === "DIFF")?.[1] ?? `${object.tabs.Files?.length ?? 0} files`}
                </b>
                <span>{object.tabs.Files?.length ?? 0} changed paths</span>
                <small>
                  {object.tabs.Commits?.length ?? 0} commits · {object.status}
                </small>
              </div>
              {(object.tabs[tab] ?? []).map((row) => (
                <button key={row} onClick={() => onNotice(row + " opened")}>
                  <GitBranch size={14} />
                  <b>{row}</b>
                  <ChevronDown size={14} />
                </button>
              ))}
              <footer>
                <span>{object.facts.find(([label]) => label === "AUTHOR")?.[1].slice(0, 2) ?? "PR"}</span>
                <b>{object.facts.find(([label]) => label === "AUTHOR")?.[1] ?? "Author"}</b>
                <small>{object.status}</small>
              </footer>
            </div>
          )}
          {object.service === "jira" && (
            <JiraEntityView
              actionComplete={actionComplete}
              object={object}
              onNotice={onNotice}
              onStateChange={onJiraIssueStateChange}
              {...(jiraIssueState ? { state: jiraIssueState } : {})}
              tab={jiraTab}
            />
          )}
          {object.service === "confluence" && (
            <div className="cc-confluence-native">
              <h3>{object.tabs[tab]?.[0] ?? object.title}</h3>
              <p>{object.tabs[tab]?.[1]}</p>
              <h4>{tab === "Activity" ? "Page history" : "Before you begin"}</h4>
              <p>{object.tabs[tab]?.[2]}</p>
              {object.tabs[tab]?.[3] && (
                <pre>
                  <code>{object.tabs[tab]?.[3]}</code>
                  <button onClick={() => onNotice("Command copied")}>Copy</button>
                </pre>
              )}
              <aside>
                <ShieldCheck size={15} />
                <span>
                  <b>Release evidence</b>
                  <small>
                    {object.status} · {object.relationships.map(({ label }) => label).join(" · ")}
                  </small>
                </span>
              </aside>
            </div>
          )}
          {object.service === "pipeline" && (
            <div className={`cc-pipeline-native ${tab === "Live execution" ? "stages" : "rows"}`}>
              {tab === "Live execution" ? (
                <>
                  {(object.tabs[tab] ?? []).slice(0, 3).map((stage, index) => (
                    <button
                      className={
                        stage.toLowerCase().includes("fail") && !actionComplete
                          ? "failed"
                          : stage.toLowerCase().includes("pass") || actionComplete
                            ? "passed"
                            : "waiting"
                      }
                      key={stage}
                      onClick={() => onNotice(stage + " opened")}
                    >
                      <small>0{index + 1}</small>
                      <b>{stage.split(" · ")[0]}</b>
                      <span>{stage.split(" · ").slice(1).join(" · ") || object.status}</span>
                    </button>
                  ))}
                  <div>
                    <time>{object.activity[0]?.split(" · ")[0] ?? "NOW"}</time>
                    <b>{actionComplete ? object.completedVerdict : object.activity[0]}</b>
                    <small>
                      {object.status} · {object.facts.find(([label]) => label === "TARGET")?.[1]}
                    </small>
                  </div>
                </>
              ) : (
                (object.tabs[tab] ?? []).map((row, index) => (
                  <button
                    className="entity-row"
                    key={row}
                    onClick={() => onNotice(`${tab === "Artifacts" ? "Download" : "Open"} ${row}`)}
                  >
                    {tab === "Artifacts" ? <Box size={15} /> : <Activity size={15} />}
                    <span>
                      <b>{row}</b>
                      <small>
                        {tab === "Artifacts" ? `Artifact ${index + 1} · verified` : `Log event ${index + 1}`}
                      </small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                ))
              )}
            </div>
          )}
          {object.service === "clockify" && (
            <div className="cc-clockify-native">
              <strong>{object.facts.find(([label]) => label === "TOTAL")?.[1] ?? object.status}</strong>
              <span>{object.facts.find(([label]) => label === "DATE")?.[1]}</span>
              {(object.tabs[tab] ?? []).map((row) => (
                <div key={row}>
                  <i />
                  <b>{row}</b>
                  <small>{object.status}</small>
                </div>
              ))}
            </div>
          )}
        </article>
        <aside className="cc-entity-rail">
          <section>
            <h2>Object facts</h2>
            {object.facts.map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <b>{value}</b>
              </div>
            ))}
          </section>
          <section>
            <h2>In this delivery</h2>
            {object.relationships.map((relationship) => (
              <button
                key={relationship.relation + relationship.label}
                onClick={() => onOpenRelated(relationship.targetId)}
              >
                <Link2 size={13} />
                <span>
                  {relationship.relation} · {relationship.label}
                </span>
                <ArrowRight size={13} />
              </button>
            ))}
          </section>
          <section className="agent">
            <Bot size={17} />
            <div>
              <b>Ask about this {serviceName} object</b>
              <small>Scope includes code, work, evidence, and delivery history.</small>
            </div>
            <button onClick={onAsk}>Ask agent</button>
          </section>
        </aside>
      </div>
    </section>
  )
}

export function AgentCodeReviewDialog({
  entity,
  onChange,
  onClose,
  review
}: {
  readonly entity: EntityRecord
  readonly onChange: (review: AgentCodeReview) => void
  readonly onClose: () => void
  readonly review?: AgentCodeReview
}) {
  const [diffMode, setDiffMode] = useState<"split" | "stacked">("split")
  const [selectedFile, setSelectedFile] = useState<"retry" | "telemetry">("retry")
  const [contextExpanded, setContextExpanded] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<FocusTarget | null>(null)
  const closeCallbackRef = useRef(onClose)
  closeCallbackRef.current = onClose
  const changeCallbackRef = useRef(onChange)
  changeCallbackRef.current = onChange
  const prNumber = entity.id.split(":").at(-1) ?? "pr"
  const sandbox = review?.sandbox ?? `guardian/pr-${prNumber}-${entity.id.length.toString(16)}a`
  const status = review?.status ?? "checking-out"
  const statusRank = status === "checking-out" ? 0 : status === "analyzing" ? 1 : 2

  useEffect(() => {
    previousFocusRef.current = activeElement()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCallbackRef.current()
      if (event.key !== "Tab") return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []
      )
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
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [])

  const steps: ReadonlyArray<readonly [string, string]> = [
    [
      "Sandbox checkout",
      `Isolated ${sandbox} from ${entity.facts.find(([label]) => label === "SOURCE")?.[1] ?? "PR head"}`
    ],
    ["Code analysis", "Tracing changed paths, tests, and release relationships"],
    ["Review findings", "2 suggestions · no release-blocking defects"]
  ]
  const telemetryFile = selectedFile === "telemetry"
  return (
    <div
      className="cc-modal-backdrop cc-agent-review-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label={`Agent review of ${entity.title}`}
        aria-modal="true"
        className="cc-agent-review-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <span>
            <Bot size={22} />
          </span>
          <div>
            <small>RELEASE GUARDIAN · ISOLATED REVIEW</small>
            <h2>
              {status === "approved"
                ? "Pull request approved"
                : status === "changes-requested"
                  ? "Changes requested"
                  : status === "completed"
                    ? "Findings ready"
                    : "Reviewing the pull request"}
            </h2>
            <p>{entity.title}</p>
          </div>
          <button aria-label="Close agent review" onClick={onClose} ref={closeRef}>
            <X size={19} />
          </button>
        </header>
        <div className="cc-agent-review-sandbox">
          <Terminal size={16} />
          <span>
            <small>SANDBOX</small>
            <b>{sandbox}</b>
          </span>
          <i>
            {status === "completed" || status === "approved" || status === "changes-requested" ? "closed" : "active"}
          </i>
        </div>
        <ol className="cc-agent-review-steps" aria-live="polite">
          {steps.map(([label, detail], index) => {
            const state =
              index < statusRank || status === "completed" || status === "approved" || status === "changes-requested"
                ? "done"
                : index === statusRank
                  ? "active"
                  : "waiting"
            return (
              <li className={state} key={label}>
                <span>
                  {state === "done" ? <Check size={15} /> : state === "active" ? <LoaderCircle size={15} /> : index + 1}
                </span>
                <div>
                  <b>{label}</b>
                  <small>{detail}</small>
                </div>
              </li>
            )
          })}
        </ol>
        {(status === "completed" || status === "approved" || status === "changes-requested") && (
          <section className="cc-agent-review-findings">
            <header>
              <span>2</span>
              <div>
                <b>Suggestions</b>
                <small>No release blockers found</small>
              </div>
            </header>
            <div className="cc-agent-review-workbench">
              <nav aria-label="Files with findings">
                <small>FILES</small>
                <button
                  className={selectedFile === "retry" ? "active" : ""}
                  onClick={() => {
                    setSelectedFile("retry")
                    setContextExpanded(false)
                  }}
                >
                  <b>retry-policy.ts</b>
                  <i>+12 −4</i>
                </button>
                <button
                  className={selectedFile === "telemetry" ? "active" : ""}
                  onClick={() => {
                    setSelectedFile("telemetry")
                    setContextExpanded(false)
                  }}
                >
                  <b>telemetry.ts</b>
                  <i>+6 −2</i>
                </button>
              </nav>
              <div className={`cc-agent-review-diff ${diffMode}`}>
                <header>
                  <code>{telemetryFile ? "src/observability/telemetry.ts" : "src/policy/retry-policy.ts"}</code>
                  <span className="add">{telemetryFile ? "+6" : "+12"}</span>
                  <span className="del">{telemetryFile ? "−2" : "−4"}</span>
                  <div>
                    <button className={diffMode === "split" ? "active" : ""} onClick={() => setDiffMode("split")}>
                      Split
                    </button>
                    <button className={diffMode === "stacked" ? "active" : ""} onClick={() => setDiffMode("stacked")}>
                      Stacked
                    </button>
                  </div>
                </header>
                <button
                  aria-expanded={contextExpanded}
                  className="cc-diff-collapsed"
                  onClick={() => setContextExpanded((current) => !current)}
                >
                  {contextExpanded ? "Collapse unchanged lines" : `··· ${telemetryFile ? 21 : 36} unchanged lines ···`}
                </button>
                {contextExpanded && (
                  <>
                    <div className="cc-diff-line context">
                      <i>79</i>
                      <i>79</i>
                      <code>
                        {telemetryFile ? "const tags = buildMetricTags(request)" : "if (budget.remaining === 0) {"}
                      </code>
                    </div>
                    <div className="cc-diff-line context">
                      <i>80</i>
                      <i>80</i>
                      <code>
                        {telemetryFile
                          ? "const duration = clock.elapsed(startedAt)"
                          : "  telemetry.markExhausted(request)"}
                      </code>
                    </div>
                    <div className="cc-diff-line context">
                      <i>81</i>
                      <i>81</i>
                      <code>{telemetryFile ? 'metrics.increment("retry.attempt", tags)' : "}"}</code>
                    </div>
                  </>
                )}
                <div className="cc-diff-line removed">
                  <i>82</i>
                  <i>82</i>
                  <code>
                    {telemetryFile
                      ? "tags.endpoint = request.url.pathname"
                      : 'throw new RetryError("budget exhausted")'}
                  </code>
                </div>
                <div className="cc-diff-line added">
                  <i>83</i>
                  <i>82</i>
                  <code>
                    {telemetryFile
                      ? "tags.endpoint = normalizeRoute(request.route)"
                      : 'throw new RetryError("budget exhausted", { request })'}
                  </code>
                </div>
                <div className="cc-diff-line added">
                  <i>84</i>
                  <i>83</i>
                  <code>
                    {telemetryFile
                      ? 'metrics.increment("retry.exhausted", tags)'
                      : "telemetry.recordExhaustion(request.route)"}
                  </code>
                </div>
                <aside>
                  <Bot size={14} />
                  <p>
                    <b>{telemetryFile ? "Bound the endpoint label" : "Keep the request context"}</b>
                    <small>
                      {telemetryFile
                        ? "The raw URL creates one metric series per identifier. Emit the normalized route template instead."
                        : "The final attempt loses the route and correlation ID. Preserve the request in the terminal error."}
                    </small>
                  </p>
                  <em>{telemetryFile ? "Low" : "Medium"}</em>
                </aside>
              </div>
            </div>
          </section>
        )}
        <footer className={status === "completed" ? "decision" : ""}>
          <span>
            {status === "approved"
              ? "Approved by Alex K. · agent evidence retained"
              : status === "changes-requested"
                ? "Changes requested by Alex K. · findings remain visible"
                : status === "completed"
                  ? "Analysis finished · review the findings before approval."
                  : "You can close this sheet; review continues in the sandbox."}
          </span>
          {status === "completed" && (
            <button
              className="request-changes"
              onClick={() => changeCallbackRef.current({ sandbox, status: "changes-requested" })}
            >
              Request changes
            </button>
          )}
          <button
            onClick={() => {
              if (status === "completed") {
                changeCallbackRef.current({ sandbox, status: "approved" })
                return
              }
              onClose()
            }}
          >
            {status === "completed"
              ? "Approve PR"
              : status === "approved" || status === "changes-requested"
                ? "Done"
                : "Run in background"}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function EntityActionDialog({
  entity,
  onCancel,
  onConfirm,
  onSelectLink,
  selectedLink
}: {
  readonly entity: EntityRecord
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly onSelectLink: (target: string) => void
  readonly selectedLink: string | null
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<FocusTarget | null>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const linkCandidates: ReadonlyArray<readonly [string, string]> =
    entity.id === "jira:RISK-61"
      ? [["pr:risk-engine:74", "PR #74 · Explain score overrides"]]
      : [["pr:payments-api:301", "PR #301 · Refund-flow telemetry"]]
  const requiresLink = entity.action === "Link pull request"
  useEffect(() => {
    previousFocusRef.current = activeElement()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelRef.current()
      if (event.key !== "Tab") return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []
      )
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
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [])
  return (
    <div
      className="cc-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <section
        ref={dialogRef}
        className="cc-action-view review"
        role="dialog"
        aria-modal="true"
        aria-label={"Confirm " + entity.action}
      >
        <header>
          <div>
            <small>GOVERNED SERVICE ACTION</small>
            <h2>Confirm {entity.action}</h2>
          </div>
          <button ref={closeRef} aria-label="Cancel action" onClick={onCancel}>
            <X size={17} />
          </button>
        </header>
        <div className="cc-action-body">
          <div className="cc-blocker-summary">
            <span>
              <ShieldCheck size={17} />
            </span>
            <div>
              <small>IMPACT</small>
              <b>{entity.title}</b>
              <p>{entity.impact}</p>
            </div>
          </div>
          {requiresLink && (
            <>
              <h3 className="cc-view-subhead">Select the verified pull request</h3>
              <div className="cc-pr-candidates">
                {linkCandidates.map(([target, label]) => (
                  <button
                    aria-pressed={selectedLink === target}
                    className={selectedLink === target ? "selected" : ""}
                    key={target}
                    onClick={() => onSelectLink(target)}
                  >
                    <ServiceIcon service="code" />
                    <span>
                      <b>{label}</b>
                      <small>Typed relationship target · checks verified</small>
                    </span>
                    {selectedLink === target && <Check size={14} />}
                  </button>
                ))}
              </div>
            </>
          )}
          {entity.service === "confluence" && (
            <div className="cc-link-preview">
              <b>Owner-confirmed revision</b>
              <span>Evidence source · linked pipeline execution and release trace</span>
              <span>Proposed revision · replace stale rollout steps</span>
              <span>Publish result · new verified page version after owner approval</span>
            </div>
          )}
          <label className="cc-check">
            <input type="checkbox" checked disabled readOnly />
            Required by workspace policy: record actor, permission, evidence, result, time, and target
          </label>
        </div>
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="cc-primary" disabled={requiresLink && !selectedLink} onClick={onConfirm}>
            Confirm action
          </button>
        </footer>
      </section>
    </div>
  )
}
