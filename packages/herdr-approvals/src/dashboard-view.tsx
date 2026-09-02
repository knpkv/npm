import { Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { FreshnessStamp } from "@knpkv/rly/patterns"
import type { FormEvent, KeyboardEvent, ReactElement } from "react"
import type { DashboardSnapshot, PendingApproval, PendingApprovalFailure } from "./dashboard-model.js"
import type { ChatMode } from "@knpkv/herdr-coordinator/model"
import { CoordinatorChatPanel, NotificationPanel, type NotificationState } from "./approval-app-view.js"
import { requiresApproval } from "@knpkv/herdr-fleet/model"
import { ActivityHistory, jobTitle, statusLabel, statusTone } from "./activity-history.js"
import { ApprovalRequestDisclosure } from "./approval-request-view.js"
import type { SanitizedJobRecord } from "./approval-request.js"

export type ApprovalDecision = {
  readonly decision: "approve" | "reject"
  readonly jobId: string
}

export const approvalShortcutFor = ({
  key,
  modified,
  shift
}: {
  readonly key: string
  readonly modified: boolean
  readonly shift: boolean
}): ApprovalDecision["decision"] | null => {
  if (!modified) return null
  if (key === "Enter" && !shift) return "approve"
  if (key === "Backspace" && shift) return "reject"
  return null
}

type DashboardViewProps = {
  readonly approvalOnly?: boolean
  readonly busyJobId: string | null
  readonly chatBusy: boolean
  readonly notificationState: NotificationState
  readonly historyLoading?: boolean
  readonly pendingLoading?: boolean
  readonly onChatSubmit: ((mode: ChatMode, message: string) => Promise<boolean>) | undefined
  readonly onDecision: ((decision: ApprovalDecision) => void) | undefined
  readonly onDisableNotifications: (() => void) | undefined
  readonly onEnableNotifications: (() => void) | undefined
  readonly onLoadHistory?: (() => void) | undefined
  readonly onLoadPending?: (() => void) | undefined
  readonly onRefresh: (() => void) | undefined
  readonly pull: {
    readonly distance: number
    readonly ready: boolean
    readonly refreshing: boolean
  }
  readonly snapshot: DashboardSnapshot
  readonly showHeader?: boolean
}

type PendingAgendaItem =
  | {
      readonly _tag: "local"
      readonly record: SanitizedJobRecord
    }
  | {
      readonly _tag: "remote"
      readonly remote: DashboardSnapshot["pendingApprovals"]["remote"][number]
    }

const pendingCreatedAt = (item: PendingAgendaItem): number =>
  item._tag === "local" ? item.record.createdAt : item.remote.approval.createdAt

const jobSummary = (record: Pick<SanitizedJobRecord, "payload">): string => {
  switch (record.payload.kind) {
    case "browser.mcp.recover":
      return "Local browser MCP recovery"
    case "nix.check":
      return "Repository checks"
    case "nix.apply":
      return "Nix configuration request"
    case "agent.delegate":
      return `${record.payload.mode} · [redacted internal prompt]`
    case "agent.message":
      return `${record.payload.session} · [redacted internal message]`
  }
}

const iso = (timestamp: number): string => new Date(timestamp).toISOString()

const timeLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp)

const lifecycleTime = (label: string, timestamp: number | null | undefined, actor?: string | null): ReactElement => (
  <li>
    <span>{label}</span>
    {timestamp == null ? (
      <small>Time unavailable</small>
    ) : (
      <time dateTime={iso(timestamp)}>{timeLabel(timestamp)}</time>
    )}
    {actor == null ? null : <small>by {actor}</small>}
  </li>
)

const JobTimeline = ({ record }: { readonly record: SanitizedJobRecord }) => (
  <ol className="job-lifecycle" aria-label="Job lifecycle">
    {lifecycleTime("Arrived", record.createdAt, record.actor)}
    {record.approvedBy === null ? null : lifecycleTime("Approved", record.approvedAt, record.approvedBy)}
    {record.status === "rejected" || record.rejectedBy != null
      ? lifecycleTime("Rejected", record.rejectedAt, record.rejectedBy)
      : null}
    {record.status === "expired"
      ? lifecycleTime("Expired", record.expiredAt)
      : record.status === "pending_approval"
        ? lifecycleTime("Expires", record.approvalExpiresAt)
        : null}
  </ol>
)

const ApprovalActions = ({
  busy,
  onDecision,
  record
}: {
  readonly busy: boolean
  readonly onDecision: ((decision: ApprovalDecision) => void) | undefined
  readonly record: SanitizedJobRecord
}) => {
  if (onDecision === undefined || record.status !== "pending_approval" || !record.approvalAvailable) {
    return null
  }
  const submit =
    (decision: "approve" | "reject") =>
    (event: FormEvent<HTMLFormElement>): void => {
      if (onDecision === undefined) return
      event.preventDefault()
      onDecision({
        decision,
        jobId: record.id
      })
    }
  const jobPath = encodeURIComponent(record.id)
  return (
    <div className="approval-actions">
      <form method="post" action={`/v1/jobs/${jobPath}/reject`} onSubmit={submit("reject")}>
        <Button type="submit" variant="quiet" disabled={busy}>
          Reject
        </Button>
      </form>
      <form method="post" action={`/v1/jobs/${jobPath}/approve`} onSubmit={submit("approve")}>
        <Button type="submit" variant="primary" loading={busy}>
          Approve
        </Button>
      </form>
    </div>
  )
}

const AgendaItem = ({
  busy,
  connectBaseUrl,
  host,
  onDecision,
  record
}: {
  readonly busy: boolean
  readonly connectBaseUrl: string
  readonly host: string
  readonly onDecision: ((decision: ApprovalDecision) => void) | undefined
  readonly record: SanitizedJobRecord
}) => {
  const handleShortcut = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget || busy || onDecision === undefined) return
    const decision = approvalShortcutFor({
      key: event.key,
      modified: event.ctrlKey || event.metaKey,
      shift: event.shiftKey
    })
    if (decision === null || record.status !== "pending_approval" || !record.approvalAvailable) return
    event.preventDefault()
    onDecision({ decision, jobId: record.id })
  }
  const actionable = onDecision !== undefined && record.status === "pending_approval" && record.approvalAvailable
  return (
    <Surface
      as="article"
      padding="default"
      tone="secondary"
      className="agenda-item"
      data-agenda-item=""
      data-approval-host={host}
      data-approval-job={record.id}
      onKeyDown={handleShortcut}
      tabIndex={0}
    >
      <div className="agenda-heading">
        <div>
          <Text as="h3" variant="card-title">
            {jobTitle(record)}
          </Text>
          <Text as="p" tone="secondary">
            {jobSummary(record)}
          </Text>
        </div>
        <StateLabel label={statusLabel(record.status)} tone={statusTone(record.status)} size="compact" />
      </div>
      <JobTimeline record={record} />
      {requiresApproval(record.payload) ? <ApprovalRequestDisclosure id={record.id} payload={record.payload} /> : null}
      {record.connectTarget === undefined || record.worker === undefined ? null : (
        <a className="worker-connect-link" href={new URL(record.connectTarget.url, connectBaseUrl).href}>
          Open {record.worker.name} in Connect
        </a>
      )}
      <ApprovalActions busy={busy} onDecision={onDecision} record={record} />
      {actionable ? (
        <div className="keyboard-hints" aria-label="Approval keyboard shortcuts">
          <span>
            <kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd> Approve
          </span>
          <span>
            <kbd>⌘/Ctrl</kbd> <kbd>Shift</kbd> <kbd>⌫</kbd> Reject
          </span>
        </div>
      ) : null}
    </Surface>
  )
}

const RemoteAgendaItem = ({
  approval,
  approvalUrl,
  host
}: {
  readonly approval: PendingApproval
  readonly approvalUrl: string
  readonly host: string
}) => (
  <Surface
    as="article"
    padding="default"
    tone="secondary"
    className="agenda-item agenda-item-remote"
    data-agenda-item=""
    data-approval-host={host}
    data-approval-job={approval.id}
    tabIndex={0}
  >
    <div className="agenda-heading">
      <div>
        <Text variant="meta" tone="secondary">
          Remote · {host}
        </Text>
        <Text as="h3" variant="card-title">
          {jobTitle(approval)}
        </Text>
        <Text as="p" tone="secondary">
          {jobSummary(approval)}
        </Text>
      </div>
      <StateLabel label="Waiting" tone="caution" size="compact" />
    </div>
    <ol className="job-lifecycle" aria-label="Job lifecycle">
      {lifecycleTime("Arrived", approval.createdAt, approval.actor)}
      {lifecycleTime("Expires", approval.approvalExpiresAt)}
    </ol>
    <ApprovalRequestDisclosure id={approval.id} payload={approval.payload} />
    <a className="remote-approval-link" href={approvalUrl} aria-label={`Review approval on ${host}`}>
      Review on {host}
    </a>
  </Surface>
)

const pendingFailureLabel = (failure: PendingApprovalFailure): string => {
  switch (failure.reason) {
    case "offline":
      return `${failure.host} offline`
    case "unavailable":
      return `${failure.host} unavailable`
    case "timeout":
      return `${failure.host} timed out`
    case "request_failed":
      return `${failure.host} request failed`
    case "invalid_response":
      return `${failure.host} returned invalid data`
  }
}

const Summary = ({ snapshot }: { readonly snapshot: DashboardSnapshot }) => {
  const pending = snapshot.pendingApprovals.local.length + snapshot.pendingApprovals.remote.length
  const pendingUnknown = snapshot.pendingApprovals.failures.length > 0
  const active = snapshot.records.filter((record) => record.status === "queued" || record.status === "running").length
  const agents = snapshot.status.herdr.agents.length
  return (
    <section className="summary-grid" aria-label="Current host state">
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Agents online
        </Text>
        <strong>{agents}</strong>
        <small>{snapshot.status.herdr.available ? "Herdr connected" : "Herdr unavailable"}</small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Needs approval
        </Text>
        <strong>{pendingUnknown ? `${pending}+` : pending}</strong>
        <small>
          {pendingUnknown ? "Some machines unchecked" : pending === 0 ? "Nothing waiting" : "Decision required"}
        </small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Active work
        </Text>
        <strong>{active}</strong>
        <small>Queued or running</small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Repository
        </Text>
        <strong className="summary-branch">{snapshot.status.branch}</strong>
        <small>{snapshot.status.dirty ? "Local changes" : "Clean"}</small>
      </Surface>
    </section>
  )
}

const ApprovalSummary = ({ snapshot }: { readonly snapshot: DashboardSnapshot }) => {
  const local = snapshot.pendingApprovals.local.length
  const remote = snapshot.pendingApprovals.remote.length
  const recentDecisions = snapshot.records.filter(
    (record) =>
      requiresApproval(record.payload) &&
      (record.approvedBy !== null || record.rejectedBy !== null || record.status === "expired")
  ).length
  return (
    <section className="summary-grid" aria-label="Approval state">
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Pending
        </Text>
        <strong>{local + remote}</strong>
        <small>Exact decisions waiting</small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Local decisions
        </Text>
        <strong>{local}</strong>
        <small>Owned by this host</small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Remote handoffs
        </Text>
        <strong>{remote}</strong>
        <small>Open on owning host</small>
      </Surface>
      <Surface padding="default" tone="secondary">
        <Text variant="meta" tone="secondary">
          Recent decisions
        </Text>
        <strong>{recentDecisions}</strong>
        <small>Approved, rejected, or expired</small>
      </Surface>
    </section>
  )
}

export const AgentActivity = ({ snapshot }: { readonly snapshot: DashboardSnapshot }) => (
  <Surface as="section" padding="spacious" className="agents-panel">
    <div className="section-heading">
      <div>
        <Text variant="meta" tone="secondary">
          Right now
        </Text>
        <Text as="h2" variant="section-title">
          Agent activity
        </Text>
      </div>
      <StateLabel
        label={`${snapshot.status.herdr.agents.length} agents`}
        tone={snapshot.status.herdr.available ? "positive" : "critical"}
        size="compact"
      />
    </div>
    <div className="agent-grid">
      {snapshot.status.herdr.agents.map((agent) => (
        <Surface key={agent.paneId} tone="tertiary" padding="compact">
          <div className="agent-line">
            <span className="agent-presence" aria-hidden="true" />
            <div>
              <Text as="strong" variant="label">
                {agent.name}
              </Text>
              <Text as="small" variant="meta" tone="secondary">
                {agent.kind} · {agent.work}
              </Text>
            </div>
            <StateLabel label={agent.status} tone="progress" size="compact" />
          </div>
        </Surface>
      ))}
      {snapshot.status.herdr.agents.length === 0 ? <Text tone="secondary">No active agents.</Text> : null}
    </div>
  </Surface>
)

const ApprovalDecisionHistory = ({ records }: { readonly records: ReadonlyArray<SanitizedJobRecord> }) => {
  type DecisionPresentation = {
    readonly actor: string
    readonly label: "Approved" | "Expired" | "Rejected"
    readonly timestamp: number
    readonly tone: "caution" | "critical" | "positive"
  }
  const decisionFor = (record: SanitizedJobRecord): DecisionPresentation | null => {
    if (record.rejectedBy != null) {
      return {
        actor: record.rejectedBy,
        label: "Rejected",
        timestamp: record.rejectedAt ?? record.updatedAt,
        tone: "critical"
      }
    }
    if (record.status === "expired") {
      return { actor: "hostd", label: "Expired", timestamp: record.expiredAt ?? record.updatedAt, tone: "caution" }
    }
    if (record.approvedBy !== null) {
      return {
        actor: record.approvedBy,
        label: "Approved",
        timestamp: record.approvedAt ?? record.updatedAt,
        tone: "positive"
      }
    }
    return null
  }
  const decisions = records
    .filter((record) => requiresApproval(record.payload))
    .flatMap((record) => {
      const decision = decisionFor(record)
      return decision === null ? [] : [{ decision, record }]
    })
    .sort((left, right) => right.decision.timestamp - left.decision.timestamp)
  const visibleDecisions = decisions.slice(0, 10)
  return (
    <Surface as="section" padding="spacious" className="decision-history-panel">
      <div className="section-heading">
        <div>
          <Text variant="meta" tone="secondary">
            Decisions
          </Text>
          <Text as="h2" variant="section-title">
            Recent approval history
          </Text>
        </div>
        <Text variant="meta" tone="secondary">
          {visibleDecisions.length} recent · {decisions.length} total
        </Text>
      </div>
      {decisions.length === 0 ? (
        <Text tone="secondary">No approval decisions yet.</Text>
      ) : (
        <ol className="decision-history-list">
          {visibleDecisions.map(({ decision, record }) => (
            <li key={record.id}>
              <div>
                <Text as="strong" variant="label">
                  {jobTitle(record)}
                </Text>
                <Text tone="secondary" variant="meta">
                  {timeLabel(decision.timestamp)} · {decision.actor}
                </Text>
                <ApprovalRequestDisclosure id={record.id} payload={record.payload} />
              </div>
              <StateLabel label={decision.label} size="compact" tone={decision.tone} />
            </li>
          ))}
        </ol>
      )}
    </Surface>
  )
}

const Machines = ({ snapshot }: { readonly snapshot: DashboardSnapshot }) => {
  if (snapshot.directory === null) return null
  return (
    <Surface as="section" padding="spacious" className="machine-panel">
      <div className="section-heading">
        <div>
          <Text variant="meta" tone="secondary">
            Fleet
          </Text>
          <Text as="h2" variant="section-title">
            Other machines
          </Text>
        </div>
      </div>
      <nav className="machine-grid" aria-label="Fleet approval pages">
        <a className="machine machine-current" href={snapshot.directory.currentUrl}>
          <StateLabel label="This machine" tone="progress" size="compact" />
          <strong>{snapshot.host}</strong>
        </a>
        {snapshot.directory.links.map((link) =>
          link.url !== null && link.online ? (
            <a key={link.host} className="machine" href={link.url}>
              <StateLabel label="Online" tone="positive" size="compact" />
              <strong>{link.host}</strong>
            </a>
          ) : (
            <span key={link.host} className="machine machine-offline">
              <StateLabel label="Offline" tone="neutral" size="compact" />
              <strong>{link.host}</strong>
            </span>
          )
        )}
      </nav>
      {snapshot.directory.error === null ? null : (
        <Text className="notice" tone="secondary">
          Machine links unavailable. Local approvals still work.
        </Text>
      )}
    </Surface>
  )
}

export const DashboardView = ({
  approvalOnly = false,
  busyJobId,
  chatBusy,
  historyLoading = false,
  notificationState,
  onChatSubmit,
  onDecision,
  onDisableNotifications,
  onEnableNotifications,
  onLoadHistory,
  onLoadPending,
  onRefresh,
  pendingLoading = false,
  pull,
  showHeader = true,
  snapshot
}: DashboardViewProps) => {
  const active = snapshot.records.filter(
    (record) => !approvalOnly && (record.status === "queued" || record.status === "running")
  )
  const pendingAgenda: ReadonlyArray<PendingAgendaItem> = [
    ...snapshot.pendingApprovals.local.map((record): PendingAgendaItem => ({ _tag: "local", record })),
    ...snapshot.pendingApprovals.remote.map((remote): PendingAgendaItem => ({ _tag: "remote", remote }))
  ].sort((left, right) => pendingCreatedAt(right) - pendingCreatedAt(left))
  const pendingUnknown = snapshot.pendingApprovals.failures.length > 0
  const agendaCount = pendingAgenda.length + active.length
  const history = snapshot.records.filter(
    (record) =>
      (!approvalOnly || requiresApproval(record.payload)) &&
      record.status !== "pending_approval" &&
      record.status !== "queued" &&
      record.status !== "running"
  )
  const pullLabel = pull.refreshing ? "Refreshing" : pull.ready ? "Release to refresh" : "Pull to refresh"
  const approvalDecision = snapshot.approvalsEnabled ? onDecision : undefined
  const moveAgendaFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-agenda-item]")]
    const currentIndex = items.findIndex((item) => item === event.target)
    if (currentIndex < 0 || items.length === 0) return
    let nextIndex: number | null = null
    switch (event.key) {
      case "ArrowDown":
      case "j":
        nextIndex = (currentIndex + 1) % items.length
        break
      case "ArrowUp":
      case "k":
        nextIndex = (currentIndex - 1 + items.length) % items.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = items.length - 1
        break
    }
    if (nextIndex === null) return
    const next = items.at(nextIndex)
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  }
  return (
    <div
      className="dashboard-root"
      data-pulling={pull.distance > 0}
      data-pull-ready={pull.ready}
      style={{ "--pull-distance": `${pull.distance}px` }}
    >
      <div className="pull-refresh" aria-hidden="true">
        <span>↓</span>
        <strong>{pullLabel}</strong>
      </div>
      <main className="app">
        {showHeader ? (
          <header className="app-header">
            <div className="fleet-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="app-title">
              <Text variant="meta" tone="secondary">
                Host activity
              </Text>
              <Text as="h1" variant="page-title">
                {snapshot.host}
              </Text>
            </div>
            <div className="header-actions">
              {snapshot.approvalApp.canonical ? (
                <nav className="fleet-app-nav" aria-label="Fleet applications">
                  <a href="/" aria-current="page">
                    Approvals
                  </a>
                  <a href="/connect/">Connect</a>
                </nav>
              ) : null}
              <FreshnessStamp
                state="current"
                dateTime={iso(snapshot.observedAt)}
                time={timeLabel(snapshot.observedAt)}
                size="compact"
              />
              {onRefresh === undefined ? null : (
                <Button variant="quiet" size="compact" onClick={onRefresh}>
                  Refresh
                </Button>
              )}
            </div>
          </header>
        ) : null}
        {approvalOnly ? <ApprovalSummary snapshot={snapshot} /> : <Summary snapshot={snapshot} />}
        {snapshot.approvalApp.canonical && snapshot.chat !== null ? (
          <>
            <NotificationPanel
              canonicalUrl={snapshot.approvalApp.canonicalUrl}
              onDisable={onDisableNotifications}
              onEnable={onEnableNotifications}
              state={notificationState}
            />
            {approvalOnly ? null : (
              <CoordinatorChatPanel busy={chatBusy} history={snapshot.chat} onSubmit={onChatSubmit} />
            )}
          </>
        ) : snapshot.approvalApp.canonical ? null : (
          <Surface padding="default" tone="secondary" className="hub-link">
            <Text tone="secondary">Notifications and coordinator chat live on the canonical hub.</Text>
            <a href={snapshot.approvalApp.canonicalUrl}>Open {new URL(snapshot.approvalApp.canonicalUrl).host}</a>
          </Surface>
        )}
        {approvalOnly ? null : <AgentActivity snapshot={snapshot} />}
        <Surface as="section" padding="spacious" className="agenda-panel">
          <div className="section-heading">
            <div>
              <Text variant="meta" tone="secondary">
                Agenda
              </Text>
              <Text as="h2" variant="section-title">
                Needs attention
              </Text>
            </div>
            <StateLabel
              label={`${agendaCount} ${pendingUnknown ? "known " : ""}open`}
              tone={agendaCount === 0 && !pendingUnknown ? "positive" : "caution"}
              size="compact"
            />
          </div>
          <div className="agenda-list" onKeyDown={moveAgendaFocus}>
            {pendingAgenda.map((item) =>
              item._tag === "local" ? (
                <AgendaItem
                  key={item.record.id}
                  busy={busyJobId === item.record.id}
                  connectBaseUrl={snapshot.approvalApp.canonicalUrl}
                  host={snapshot.host}
                  onDecision={approvalDecision}
                  record={item.record}
                />
              ) : (
                <RemoteAgendaItem
                  key={`${item.remote.host}:${item.remote.approval.id}`}
                  approval={item.remote.approval}
                  approvalUrl={item.remote.approvalUrl}
                  host={item.remote.host}
                />
              )
            )}
            {active.map((record) => (
              <AgendaItem
                key={record.id}
                busy={busyJobId === record.id}
                connectBaseUrl={snapshot.approvalApp.canonicalUrl}
                host={snapshot.host}
                onDecision={approvalDecision}
                record={record}
              />
            ))}
            {snapshot.pendingApprovals.failures.length === 0 ? null : (
              <Text className="notice" tone="secondary">
                Could not check {snapshot.pendingApprovals.failures.map(pendingFailureLabel).join(", ")}. Local
                approvals still work.
              </Text>
            )}
            {snapshot.pendingApprovals.nextCursors.length === 0 ? null : (
              <div className="activity-load-more">
                <Button loading={pendingLoading} onClick={onLoadPending} type="button" variant="quiet">
                  Load more approvals
                </Button>
              </div>
            )}
            {agendaCount === 0 && !pendingUnknown ? (
              <div className="empty">
                <span>✓</span>
                <Text as="h3" variant="card-title">
                  Nothing waiting
                </Text>
                <Text tone="secondary">All current work is settled.</Text>
              </div>
            ) : null}
          </div>
        </Surface>
        {approvalOnly ? (
          <>
            <ApprovalDecisionHistory records={snapshot.records} />
            {snapshot.historyNextCursor === null ? null : (
              <div className="activity-load-more">
                <Button loading={historyLoading} onClick={onLoadHistory} type="button" variant="quiet">
                  Load earlier decisions
                </Button>
              </div>
            )}
          </>
        ) : (
          <ActivityHistory
            hasMore={snapshot.historyNextCursor !== null}
            loading={historyLoading}
            {...(onLoadHistory === undefined ? {} : { onLoadMore: onLoadHistory })}
            records={history}
          />
        )}
        <Machines snapshot={snapshot} />
      </main>
    </div>
  )
}
