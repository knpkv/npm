import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  GitBranch,
  Link2,
  ListTodo,
  MoreHorizontal,
  Network,
  Play,
  Plus,
  Search,
  ShieldCheck,
  X
} from "lucide-react"
import { type Dispatch, type SetStateAction, useEffect, useState } from "react"
import { type Service, ServiceIcon, type WorkflowEvent } from "./control-center-foundation.js"
import type { TraceId } from "./control-center-model.js"
import type { ControlCenterSettings } from "./control-center-state.js"

export interface LinkedItem {
  readonly id: string
  readonly kind: string
  readonly owner: string
  readonly ownerLabel: string
  readonly source: string
  readonly status: string
  readonly statusLabel: string
  readonly ticketIndex: number | null
  readonly title: string
  readonly traceId: TraceId
  readonly type: string
  readonly updated: string
}

interface ItemsViewProps {
  readonly filteredItems: ReadonlyArray<LinkedItem>
  readonly itemOwner: string
  readonly itemQuery: string
  readonly itemStatus: string
  readonly itemType: string
  readonly linkedItems: ReadonlyArray<LinkedItem>
  readonly onAdd: () => void
  readonly onOpen: (item: LinkedItem) => void
  readonly setItemOwner: Dispatch<SetStateAction<string>>
  readonly setItemQuery: Dispatch<SetStateAction<string>>
  readonly setItemStatus: Dispatch<SetStateAction<string>>
  readonly setItemType: Dispatch<SetStateAction<string>>
}

export function ItemsView({
  filteredItems,
  itemOwner,
  itemQuery,
  itemStatus,
  itemType,
  linkedItems,
  onAdd,
  onOpen,
  setItemOwner,
  setItemQuery,
  setItemStatus,
  setItemType
}: ItemsViewProps) {
  const clearFilters = () => {
    setItemQuery("")
    setItemType("all")
    setItemStatus("all")
    setItemOwner("all")
  }

  return (
    <section className="cc-section-view">
      <header>
        <div>
          <p>DELIVERY TRACE</p>
          <h1>Linked items</h1>
          <span>Every source object associated with payments-api v2.18.0.</span>
        </div>
        <button className="cc-primary" onClick={onAdd}>
          <Plus size={14} />
          Add object
        </button>
      </header>
      <div className="cc-view-toolbar">
        <label>
          <Search size={14} />
          <input
            value={itemQuery}
            onChange={(event) => setItemQuery(event.target.value)}
            placeholder={`Filter ${linkedItems.length} linked items…`}
          />
        </label>
        <select aria-label="Filter by type" value={itemType} onChange={(event) => setItemType(event.target.value)}>
          <option value="all">All types</option>
          <option value="jira">Jira</option>
          <option value="pr">Pull requests</option>
          <option value="pipeline">Pipeline</option>
          <option value="release">Release</option>
          <option value="clockify">Clockify</option>
        </select>
        <select
          aria-label="Filter by status"
          value={itemStatus}
          onChange={(event) => setItemStatus(event.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="healthy">Healthy</option>
          <option value="blocked">Blocked</option>
          <option value="missing">Missing</option>
        </select>
        <select aria-label="Filter by owner" value={itemOwner} onChange={(event) => setItemOwner(event.target.value)}>
          <option value="all">All owners</option>
          <option value="alex">Alex K.</option>
          <option value="maya">Maya Chen</option>
        </select>
        {(itemQuery || itemType !== "all" || itemStatus !== "all" || itemOwner !== "all") && (
          <button onClick={clearFilters}>Clear all</button>
        )}
      </div>
      <div className="cc-filter-summary">
        <b>{filteredItems.length}</b> of {linkedItems.length} objects
        {itemType !== "all" && <span>Type: {itemType}</span>}
        {itemStatus !== "all" && <span>Status: {itemStatus}</span>}
        {itemOwner !== "all" && <span>Owner: {itemOwner}</span>}
      </div>
      <div className="cc-items-table">
        <div className="head">
          <span>Object</span>
          <span>Source</span>
          <span>Status</span>
          <span>Owner</span>
          <span>Updated</span>
          <span />
        </div>
        {filteredItems.map((item) => (
          <button key={item.id} onClick={() => onOpen(item)}>
            <span>
              <i className={`cc-table-kind ${item.traceId}`}>
                {item.kind === "jira" ? <ListTodo size={13} /> : <Link2 size={13} />}
              </i>
              <b>
                {item.id.startsWith("PAY") || item.id.startsWith("OPS") || item.id.startsWith("SEC")
                  ? `${item.id} · `
                  : ""}
                {item.title}
              </b>
              <small>{item.type}</small>
            </span>
            <span>{item.source}</span>
            <span>
              <em className={item.status === "healthy" ? "good" : "bad"}>{item.statusLabel}</em>
            </span>
            <span>{item.ownerLabel}</span>
            <span>{item.updated}</span>
            <MoreHorizontal size={14} />
          </button>
        ))}
        {filteredItems.length === 0 && (
          <div className="cc-items-empty">
            <b>No linked items match</b>
            <span>Try clearing one or more filters.</span>
            <button onClick={clearFilters}>Clear filters</button>
          </div>
        )}
      </div>
    </section>
  )
}

interface TimelineViewProps {
  readonly filter: "agent" | "all" | "human" | "system"
  readonly onExport: () => void
  readonly onOpenRepair: () => void
  readonly onSelectTrace: (trace: TraceId) => void
  readonly range: "today" | "two-days"
  readonly setFilter: Dispatch<SetStateAction<"agent" | "all" | "human" | "system">>
  readonly setRange: Dispatch<SetStateAction<"today" | "two-days">>
  readonly workflowActivity: ReadonlyArray<WorkflowEvent>
}

const timelineActors: ReadonlyArray<TimelineViewProps["filter"]> = ["all", "human", "agent", "system"]

const isTimelineRange = (value: string): value is TimelineViewProps["range"] =>
  value === "today" || value === "two-days"

const isRefreshInterval = (value: string): value is ControlCenterSettings["refreshInterval"] =>
  value === "live" || value === "quarter-hour" || value === "manual"

export function TimelineView({
  filter,
  onExport,
  onOpenRepair,
  onSelectTrace,
  range,
  setFilter,
  setRange,
  workflowActivity
}: TimelineViewProps) {
  return (
    <section className="cc-section-view timeline">
      <header>
        <div>
          <p>DELIVERY TRACE</p>
          <h1>Activity timeline</h1>
          <span>A normalized history from Jira, CodeCommit, CodePipeline, and Clockify.</span>
        </div>
        <button onClick={onExport}>Export timeline</button>
      </header>
      <div className="cc-view-toolbar">
        {timelineActors.map((actor) => (
          <button className={filter === actor ? "active" : ""} key={actor} onClick={() => setFilter(actor)}>
            {actor === "all" ? "All activity" : actor.charAt(0).toUpperCase() + actor.slice(1)}
          </button>
        ))}
        <span />
        <select
          aria-label="Timeline date range"
          value={range}
          onChange={(event) => {
            if (isTimelineRange(event.target.value)) setRange(event.target.value)
          }}
        >
          <option value="today">12 July</option>
          <option value="two-days">11–12 July</option>
        </select>
      </div>
      <div className="cc-timeline-day">
        <h3>Today · 12 July</h3>
        {workflowActivity
          .filter((event) => filter === "all" || filter === event.actor)
          .map((event) => (
            <article key={`${event.time}-${event.label}`}>
              <i>
                {event.actor === "system" ? (
                  <Network size={13} />
                ) : event.actor === "agent" ? (
                  <Bot size={13} />
                ) : (
                  <Check size={13} />
                )}
              </i>
              <time>{event.time}</time>
              <div>
                <b>{event.label}</b>
                <p>
                  {event.actor === "human"
                    ? "Human action synchronized across the trace."
                    : event.actor === "system"
                      ? "Service event synchronized across the trace."
                      : "Agent action synchronized across the trace."}
                </p>
              </div>
              <span className={`cc-agent-avatar ${event.actor === "agent" ? "violet" : ""}`}>
                {event.actor === "system" ? (
                  <Network size={14} />
                ) : event.actor === "agent" ? (
                  <Bot size={14} />
                ) : (
                  <Check size={14} />
                )}
              </span>
            </article>
          ))}
        {(filter === "all" || filter === "system") && (
          <article className="danger">
            <i>
              <X size={13} />
            </i>
            <time>10:18</time>
            <div>
              <b>Integration stage failed</b>
              <p>3 of 128 tests failed in checkout-flow.</p>
              <button onClick={() => onSelectTrace("failure")}>
                View test execution <ArrowRight size={12} />
              </button>
            </div>
            <ServiceIcon service="pipeline" />
          </article>
        )}
        {(filter === "all" || filter === "agent") && (
          <article>
            <i>
              <Bot size={13} />
            </i>
            <time>10:07</time>
            <div>
              <b>Release Guardian completed preflight check</b>
              <p>Found the approval gap; pipeline integration tests were still running.</p>
              <button onClick={onOpenRepair}>
                Open findings <ArrowRight size={12} />
              </button>
            </div>
            <span className="cc-agent-avatar violet">
              <Bot size={14} />
            </span>
          </article>
        )}
        {(filter === "all" || filter === "system") && (
          <article>
            <i>
              <Play size={13} />
            </i>
            <time>10:03</time>
            <div>
              <b>Pipeline execution #1842 started</b>
              <p>Triggered by release candidate payments-api v2.18.0.</p>
            </div>
            <ServiceIcon service="pipeline" />
          </article>
        )}
        {(filter === "all" || filter === "human") && (
          <article>
            <i>
              <GitBranch size={13} />
            </i>
            <time>09:41</time>
            <div>
              <b>Pull request #284 merged</b>
              <p>Alex merged feat/audit-logs into main after 18 checks passed.</p>
              <button onClick={() => onSelectTrace("prOne")}>
                Inspect PR <ArrowRight size={12} />
              </button>
            </div>
            <ServiceIcon service="code" />
          </article>
        )}
        {range === "two-days" && (filter === "all" || filter === "human") && <h3>Yesterday · 11 July</h3>}
        {range === "two-days" && (filter === "all" || filter === "human") && (
          <article>
            <i>
              <Clock3 size={13} />
            </i>
            <time>17:24</time>
            <div>
              <b>Time entries linked to OPS-412</b>
              <p>3h 45m attributed across Alex and Maya.</p>
            </div>
            <ServiceIcon service="clockify" />
          </article>
        )}
      </div>
    </section>
  )
}

interface SettingsViewProps {
  readonly onManagePermissions: () => void
  readonly onOpenSource: (service: Service) => void
  readonly onReset: () => void
  readonly onSave: (settings: ControlCenterSettings) => void
  readonly settings: ControlCenterSettings
}

export function SettingsView({ onManagePermissions, onOpenSource, onReset, onSave, settings }: SettingsViewProps) {
  const [draft, setDraft] = useState(settings)
  const [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const update = <Key extends keyof ControlCenterSettings>(key: Key, value: ControlCenterSettings[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }
  useEffect(() => setDraft(settings), [settings])
  const sources: ReadonlyArray<readonly [Service, string, string]> = [
    ["jira", "Jira Cloud", "engineering.atlassian.net"],
    ["confluence", "Confluence", "Release runbooks"],
    ["code", "AWS CodeCommit", "payments-api"],
    ["pipeline", "AWS CodePipeline", "payments-production"],
    ["clockify", "Clockify", "Engineering workspace"]
  ]

  return (
    <section className="cc-section-view settings">
      <header>
        <div>
          <p>DELIVERY TRACE</p>
          <h1>Trace settings</h1>
          <span>Control discovery, evidence, agent actions, and synchronization.</span>
        </div>
        <div className="cc-settings-save">
          <span aria-live="polite">{dirty ? "Unsaved changes" : saved ? "Saved" : "All changes saved"}</span>
          <button
            className="cc-primary"
            disabled={!dirty}
            onClick={() => {
              onSave(draft)
              setSaved(true)
            }}
          >
            Save changes
          </button>
        </div>
      </header>
      <div className="cc-settings-columns">
        <div>
          <section>
            <h2>Connected sources</h2>
            <p>Services used to build and refresh this trace.</p>
            {sources.map(([service, name, detail]) => (
              <button className="cc-connection-row" key={name} onClick={() => onOpenSource(service)}>
                <ServiceIcon service={service} />
                <span>
                  <b>{name}</b>
                  <small>{detail}</small>
                </span>
                <em>Connected</em>
                <ChevronDown size={13} />
              </button>
            ))}
          </section>
          <section>
            <h2>Relationship rules</h2>
            <p>How Control Center infers connections between services.</p>
            <SettingToggle
              title="Issue keys in branches and commits"
              detail="Example: feat/OPS-412-audit-logs"
              checked={draft.inferIssueKeys}
              onChange={(checked) => update("inferIssueKeys", checked)}
            />
            <SettingToggle
              title="Release revision ancestry"
              detail="Connect merged PRs through commits"
              checked={draft.inferRevisionAncestry}
              onChange={(checked) => update("inferRevisionAncestry", checked)}
            />
            <SettingToggle
              title="Temporal Clockify matching"
              detail="Suggest time entries from activity windows"
              checked={draft.inferClockify}
              onChange={(checked) => update("inferClockify", checked)}
            />
          </section>
        </div>
        <div>
          <section>
            <h2>Synchronization</h2>
            <label className="cc-form-label">
              Refresh interval
              <select
                value={draft.refreshInterval}
                onChange={(event) => {
                  if (isRefreshInterval(event.target.value)) update("refreshInterval", event.target.value)
                }}
              >
                <option value="live">Live events + 5 minute reconciliation</option>
                <option value="quarter-hour">Every 15 minutes</option>
                <option value="manual">Manual only</option>
              </select>
            </label>
            <label className="cc-check">
              <input
                type="checkbox"
                checked={draft.retainEvidence}
                onChange={(event) => update("retainEvidence", event.target.checked)}
              />
              Retain raw evidence for 90 days
            </label>
          </section>
          <section>
            <h2>Agent policy</h2>
            <p>Actions Release Guardian may take from this trace.</p>
            <SettingToggle
              title="Investigate failures"
              detail="Read logs and correlate changes"
              checked={draft.investigateFailures}
              onChange={(checked) => update("investigateFailures", checked)}
            />
            <SettingToggle
              title="Write Jira comments"
              detail="Requires approval before posting"
              checked={draft.writeJiraComments}
              onChange={(checked) => update("writeJiraComments", checked)}
            />
            <SettingToggle
              title="Retry pipelines"
              detail="Always requires explicit approval"
              checked={draft.retryPipelines}
              onChange={(checked) => update("retryPipelines", checked)}
            />
            <button className="cc-policy-button" onClick={onManagePermissions}>
              <ShieldCheck size={14} />
              Manage workspace-wide permissions
            </button>
            <button className="cc-policy-button" onClick={onReset}>
              <Activity size={14} />
              Reset prototype data
            </button>
          </section>
        </div>
      </div>
    </section>
  )
}

function SettingToggle({
  checked,
  detail,
  onChange,
  title
}: {
  readonly checked: boolean
  readonly detail: string
  readonly onChange: (checked: boolean) => void
  readonly title: string
}) {
  return (
    <label className="cc-setting-toggle">
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}
