/**
 * A week of time, and the gaps in it.
 *
 * **Mental model**
 *
 * - **Allocated and proposable in one cell.** A gap only means something next to what is already
 *   there, which is the whole reason this is a grid and not a list of proposals.
 * - **The server authorizes writes.** The browser previews pending intervals with shared sizing
 *   rules; the server rechecks live provider totals and returns the actual result.
 * - **Review time in the calendar.** Provider entries and suggestions remain separate. Ownership
 *   exceptions and running-timer exclusions are explained below it.
 *
 * @module
 */
import { PortalProvider, type RlyTheme, ThemeProvider } from "@knpkv/rly/foundations"
import { RegistryContext } from "@effect/atom-react"
import { Region } from "@knpkv/rly/patterns"
import { Button, StatePanel, Text, ThemeSelect } from "@knpkv/rly/primitives"
import { lazy, type ReactNode, Suspense, useContext, useEffect, useMemo, useState } from "react"
import type { WeekScopeName } from "../server/Api.js"
import type { ConfirmRequest } from "./api.js"
import { useWeek } from "./useWeek.js"
import { AgentTerminal } from "./AgentTerminal.js"
import { ReadStatus } from "./ReadStatus.js"
import { EditorFrame } from "./EditorFrame.js"
import { duration, formatClock, formatDuration, shiftWeek, weekLabel } from "./format.js"
import { ConfirmPanel, ManualPanel } from "./panels.js"
import { weekTotals } from "./calendarProjection.js"
import { heldWriteProviders, ignoredTicketTotals } from "./writeHolds.js"
import { WeekGrid } from "./WeekGrid.js"
import { makeRowDescriptions } from "./rowDescriptions.js"
import { SavedEntryPanel } from "./SavedEntryPanel.js"
import type { SavedEntry, Sources, WriteResultResponse } from "../shared/contracts.js"

const AgentSettingsPanel = lazy(() => import("./AgentSettingsPanel.js"))

type OpenPanel =
  | { readonly kind: "saved"; readonly entry: SavedEntry }
  | { readonly kind: "agent" }
  | { readonly kind: "confirm"; readonly rowId: string; readonly blockIndex: number }
  | { readonly kind: "manual"; readonly day: string; readonly clock: string }

const scopeLabels: ReadonlyArray<{ readonly scope: WeekScopeName; readonly label: string }> = [
  { label: "Both", scope: "both" },
  { label: "Jira only", scope: "jira" },
  { label: "Clockify only", scope: "clockify" }
]

/** `1h 0m saved, 30m suggested`; a zero reads as "nothing" rather than `0s`. */
const totalLine = (savedSeconds: number, suggestedSeconds: number): string =>
  `${savedSeconds > 0 ? formatDuration(savedSeconds) : "nothing"} saved, ${
    suggestedSeconds > 0 ? formatDuration(suggestedSeconds) : "nothing"
  } suggested`

/** Why Log time is off right now, in the order a person can act on it. */
const logTimeReason = (state: {
  readonly loading: boolean
  readonly busy: boolean
  readonly plan: unknown
  readonly writeTargets: { readonly jira: boolean; readonly clockify: boolean }
  readonly queueActive: boolean
  readonly sources: Sources | null
}): string =>
  state.sources !== null && !state.sources.jira.connected && !state.sources.clockify.connected
    ? "Connect Jira or Clockify first."
    : state.loading
      ? "Waiting for the week to load."
      : state.plan === null
        ? "Load a week first."
        : state.busy || state.queueActive
          ? "Waiting for the current save to finish."
          : !state.writeTargets.jira && !state.writeTargets.clockify
            ? "Show the Jira or Clockify layer to log time to it."
            : "Refresh totals to read current time before logging."

/**
 * The cause as the server named it, what the page still shows, and what to do. A failed read never
 * leaves earlier totals looking current.
 */
const readFailureDescription = (cause: string, shownFrom: string | null): string =>
  `${cause.replace(/\.$/u, "")}. ${
    shownFrom === null ? "Nothing was read yet." : `The week below is from the read at ${shownFrom}.`
  } Check that Jira and Clockify are reachable and signed in, then try again.`

/** A successful segment does not make a partially failed approval complete. */
const incompleteWrite = (result: WriteResultResponse | null): boolean =>
  result !== null &&
  [result.clockify, result.jira].some(
    (outcome) => outcome._tag === "Refused" || outcome._tag === "NotLoggedIn" || outcome._tag === "PartiallyWritten"
  )

/**
 * A terminal command the reader has to run, with a Copy button: the one thing they must type, made
 * one click. If the clipboard is unavailable the button says so and the command stays selectable.
 */
const Command = (props: { readonly command: string }) => {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle")
  return (
    <span className="jcf-command">
      <code>{props.command}</code>
      <Button
        aria-label={`Copy ${props.command}`}
        onClick={() => {
          navigator.clipboard.writeText(props.command).then(
            () => setCopied("copied"),
            () => setCopied("failed")
          )
        }}
        size="compact"
      >
        {copied === "copied" ? "Copied" : copied === "failed" ? "Select to copy" : "Copy"}
      </Button>
    </span>
  )
}

/** A system jcf cannot read: its totals are unknown, not zero, and this says what connects it. */
const NotConnected = (props: { readonly command: string }) => (
  <span className="jcf-not-connected">
    not connected. Run <Command command={props.command} />
  </span>
)

/** A first-run screen: a heading in text ink and the step that gets past it. */
const FirstRun = (props: { readonly title: string; readonly children: ReactNode }) => (
  <section className="jcf-first-run" aria-labelledby="jcf-first-run-title">
    <Text as="h2" id="jcf-first-run-title" variant="card-title">
      {props.title}
    </Text>
    {props.children}
  </section>
)

/**
 * The page without a valid session: one screen naming the command that mints a new link. Nothing else
 * renders, because nothing else can work until the tab is signed in.
 */
const SignedOut = (props: { readonly theme: RlyTheme }) => {
  // A link pasted into this tab changes only the fragment, which loads nothing: start over with it.
  useEffect(() => {
    const signIn = () => {
      if (window.location.hash.includes("bootstrap_token=")) window.location.reload()
    }
    window.addEventListener("hashchange", signIn)
    return () => window.removeEventListener("hashchange", signIn)
  }, [])
  return (
    <ThemeProvider className="jcf-shell" theme={props.theme}>
      <main className="jcf-app jcf-signed-out">
        <Text as="h1" variant="section-title">
          Jira and Clockify week
        </Text>
        <FirstRun title="This tab is not signed in">
          <p>In a terminal on this machine, run this and open the link it prints:</p>
          <p>
            <Command command="jcf web login" />
          </p>
          <p className="jcf-muted">
            A link works once, within a minute. If jcf-web is not running, start it with <code>jcf-web</code>.
          </p>
        </FirstRun>
      </main>
    </ThemeProvider>
  )
}

export const App = () => {
  const registry = useContext(RegistryContext)
  const descriptions = useMemo(() => makeRowDescriptions(registry), [registry])
  const { actions, state } = useWeek()
  useEffect(() => () => descriptions.dispose(), [descriptions])
  useEffect(() => descriptions.retain(state.plan?.planId), [descriptions, state.plan?.planId])
  const {
    actionFailure: failure,
    activity,
    busy: writing,
    cancelled,
    configurationChanged,
    failure: readFailure,
    loading,
    missingPlan,
    monday,
    optimisticEntries,
    plan,
    progress,
    readMode,
    scope,
    signedOut,
    sources,
    startedAt,
    unavailable,
    written
  } = state
  // Not known yet counts as connected: "Not connected" is shown only once the server has said so.
  const jiraConnected = sources?.jira.connected !== false
  const clockifyConnected = sources?.clockify.connected !== false
  const nothingConnected = !jiraConnected && !clockifyConnected
  const savedShown =
    jiraConnected && clockifyConnected
      ? "Saved Jira and Clockify time is shown."
      : jiraConnected
        ? "Saved Jira time is shown."
        : "Saved Clockify time is shown."
  const busy = writing || state.queueActive
  const agentLogUnavailable = (activity.length === 0 && !loading) || cancelled
  const writeIncomplete = incompleteWrite(written)
  const { chooseScope, refreshRecorded } = actions
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [agentSettingsSaving, setAgentSettingsSaving] = useState(false)
  const [quickApproval, setQuickApproval] = useState(false)
  // Below 1100px the editor is a bottom sheet over the week: a scrim covers the page, which is
  // inert behind it, so focus and clicks stay in the sheet until it closes.
  const [narrowSheet, setNarrowSheet] = useState(() => window.matchMedia("(max-width: 1100px)").matches)
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)")
    const change = () => setNarrowSheet(query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  const [open, setOpen] = useState<OpenPanel | null>(null)
  const sheetOpen = narrowSheet && open !== null
  const [theme, setTheme] = useState<RlyTheme>("system")
  const [readAt, setReadAt] = useState<string | null>(null)
  useEffect(() => {
    if (plan !== null) setReadAt(formatClock(new Date()))
  }, [plan])
  const rescan = () => {
    setOpen({ kind: "agent" })
    return actions.rescan()
  }
  const retry = () => {
    if (readMode === "full") setOpen({ kind: "agent" })
    return actions.retry()
  }
  const cancel = () => {
    setOpen(null)
    actions.cancel()
  }
  const load = (week: string | undefined, which: WeekScopeName) => {
    setOpen(null)
    return actions.navigate(week, which)
  }
  useEffect(() => {
    if (loading) setOpen((current) => (current?.kind === "agent" ? current : null))
  }, [loading])

  const openRow = useMemo(
    () => (open?.kind === "confirm" ? plan?.rows.find((row) => row.rowId === open.rowId) : undefined),
    [open, plan]
  )

  const totals = useMemo(() => weekTotals(plan), [plan])
  const heldProviders = useMemo(() => heldWriteProviders(plan), [plan])
  const ignoredTotals = useMemo(() => ignoredTicketTotals(plan), [plan])

  const closeAfter = async (result: Promise<boolean>) => {
    if (await result) setOpen(null)
  }

  const confirm = (request: Omit<ConfirmRequest, "planId" | "rowId">, rowId: string) =>
    closeAfter(actions.confirm({ ...request, rowId }))

  // Feedback floats beside the calendar, or leads the open editor so it never covers the page header.
  const feedback: ReactNode = (
    <>
      {loading && readMode === "recorded" ? (
        <ReadStatus key={startedAt} progress={progress} startedAt={startedAt} onCancel={cancel} mode={readMode} />
      ) : null}
      {nothingConnected && sources !== null ? (
        <FirstRun title="Connect Jira or Clockify">
          <p>Nothing is connected yet. In a terminal on this machine, run one or both:</p>
          <ul className="jcf-commands">
            <li>
              Jira: <Command command={sources.jira.connect} />
            </li>
            <li>
              Clockify: <Command command={sources.clockify.connect} />
            </li>
          </ul>
          <p>
            <Button onClick={retry} size="compact" variant="primary">
              Show my week
            </Button>
          </p>
        </FirstRun>
      ) : readFailure === null ? null : (
        <StatePanel
          announce="assertive"
          title={readMode === "recorded" ? "Could not update logged time" : "Could not load the week"}
          description={readFailureDescription(readFailure, plan === null ? null : readAt)}
          tone="critical"
          action={
            <Button disabled={agentSettingsSaving} onClick={retry} size="compact">
              Try again
            </Button>
          }
        />
      )}
      {cancelled ? (
        <StatePanel
          title="Read cancelled"
          description={
            plan === null
              ? "No time was logged. Choose Rescan sessions when you are ready."
              : "The last loaded calendar is still shown. Refresh totals to read current time."
          }
          action={
            <Button disabled={agentSettingsSaving} onClick={retry} size="compact">
              {readMode === "recorded" ? "Refresh totals" : "Rescan sessions"}
            </Button>
          }
        />
      ) : null}
      {failure === null ? null : (
        <StatePanel announce="assertive" title="Could not complete the action" description={failure} tone="critical" />
      )}
      {written === null ? null : (
        <StatePanel
          announce="polite"
          title={writeIncomplete ? "Some time could not be logged" : "Time checked"}
          tone={writeIncomplete ? "caution" : "positive"}
          description={
            <>
              <p>{written.lines.join(". ")}</p>
              <p>{written.description}</p>
            </>
          }
        />
      )}
    </>
  )

  if (signedOut) return <SignedOut theme={theme} />

  return (
    <ThemeProvider className="jcf-shell" theme={theme}>
      <PortalProvider>
        <main className="jcf-app">
          <header className="jcf-masthead" inert={sheetOpen}>
            <Text as="h1" variant="section-title">
              Jira and Clockify week
            </Text>
            <p className="jcf-read-at" data-failed={readFailure !== null && !nothingConnected}>
              {loading
                ? "Reading the week…"
                : nothingConnected
                  ? "Nothing connected"
                  : readFailure !== null
                    ? "Last read failed"
                    : readAt === null
                      ? "Not read yet"
                      : `Read at ${readAt}`}
            </p>
            <ThemeSelect labelVisibility="hidden" onValueChange={setTheme} value={theme} />
          </header>
          <div
            className="jcf-bar"
            role="toolbar"
            aria-label="Week controls"
            inert={sheetOpen}
            hidden={nothingConnected}
          >
            <div className="jcf-bar-group" role="group" aria-label="Week">
              <Button
                aria-label="Previous week"
                disabled={busy || monday === undefined}
                onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, -1), scope)}
                size="compact"
              >
                Previous
              </Button>
              <Button disabled={busy} onClick={() => load(undefined, scope)} size="compact">
                This week
              </Button>
              <Button
                aria-label="Next week"
                disabled={busy || monday === undefined}
                onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, 1), scope)}
                size="compact"
              >
                Next
              </Button>
            </div>
            <div className="jcf-bar-group" role="group" aria-label="Systems to reconcile">
              {scopeLabels
                .filter(
                  (option) =>
                    // A system that is not connected has no week of its own to show.
                    (option.scope !== "jira" || jiraConnected) && (option.scope !== "clockify" || clockifyConnected)
                )
                .map((option) => (
                  <Button
                    aria-pressed={scope === option.scope}
                    disabled={busy}
                    key={option.scope}
                    onClick={() => {
                      setOpen(null)
                      chooseScope(option.scope)
                    }}
                    size="compact"
                    variant={option.scope === scope ? "primary" : "quiet"}
                  >
                    {option.label}
                  </Button>
                ))}
            </div>
            <div className="jcf-bar-group jcf-bar-primary">
              <span hidden id="jcf-log-time-reason">
                {logTimeReason(state)}
              </span>
              <Button
                aria-disabled={unavailable ? "true" : undefined}
                aria-describedby={unavailable ? "jcf-log-time-reason" : undefined}
                onClick={() => {
                  if (!unavailable && plan !== null) setOpen({ kind: "manual", day: plan.monday, clock: "09:00" })
                }}
                size="compact"
                variant="primary"
              >
                Log time
              </Button>
            </div>
          </div>
          {configurationChanged ? (
            <p className="jcf-note">Setting saved. Choose Rescan sessions to update the suggestions.</p>
          ) : null}
          {plan === null || open !== null ? null : (
            <div className="jcf-feedback" data-floating={readMode === "recorded" || !loading}>
              {feedback}
            </div>
          )}
          {plan !== null && plan.sessionRootCount === 0 ? (
            <p className="jcf-note" data-tone="warning">
              No Session Root is configured, so no session can become a proposal. Run{" "}
              <code>jcf config set session-root ~/dev/work</code>.
            </p>
          ) : null}
          {plan !== null && plan.ownership === "assigned" && !plan.ownershipChecked ? (
            <p className="jcf-note" data-tone="warning">
              {plan.scope === "clockify"
                ? "Clockify only, so Jira was not asked who owns these tickets. Nothing is withheld and no titles are shown."
                : "Jira could not say who owns these tickets, so nothing was withheld on ownership this week."}
            </p>
          ) : null}
          {heldProviders.length > 0 ? (
            <p className="jcf-note" data-tone="warning" role="status">
              {heldProviders.join(" and ")} writes are held for this week: earlier entries need manual review before new
              session time can be logged. Suggestions for {heldProviders.length === 1 ? "that system" : "those systems"}{" "}
              stay readable here but cannot be logged.
            </p>
          ) : null}
          {plan !== null && !plan.attributorAvailable ? (
            <p className="jcf-note" data-tone="warning">
              A Coding Agent could not be reached. Sessions without a branch or path match have no suggestions.
            </p>
          ) : null}

          {state.queued.length === 0 ? null : (
            <section className="jcf-approval-queue" aria-label="Approval queue">
              <p role="status">
                {state.queued.length} approval{state.queued.length === 1 ? "" : "s"} pending. Undo is available until
                saving starts.
              </p>
              <ul role="list">
                {state.queued.map((entry) => {
                  const label = `${entry.ticketKey}, ${entry.day}, ${formatClock(new Date(entry.startMs))}–${formatClock(new Date(entry.endMs))}`
                  return (
                    <li key={entry.id}>
                      <span>{label}</span>
                      {entry.status === "saving" ? (
                        <span>Saving…</span>
                      ) : (
                        <Button
                          size="compact"
                          aria-label={`Undo ${label}`}
                          onClick={() => actions.undoQueued(entry.id)}
                        >
                          Undo
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          <div className="jcf-workspace" data-editing={open !== null}>
            <Region
              inert={sheetOpen}
              className="jcf-week-region"
              title={plan === null ? "Your week" : weekLabel(plan.days)}
              actions={
                nothingConnected ? undefined : (
                  <div className="jcf-region-actions" role="group" aria-label="Sessions">
                    <Button
                      size="compact"
                      disabled={busy || loading || agentSettingsSaving}
                      aria-expanded={agentSettingsOpen}
                      onClick={() => setAgentSettingsOpen((open) => !open)}
                    >
                      Agent settings
                    </Button>
                    <Button
                      aria-expanded={open?.kind === "agent"}
                      aria-disabled={agentLogUnavailable ? "true" : undefined}
                      aria-describedby={agentLogUnavailable ? "jcf-agent-log-reason" : undefined}
                      onClick={() => {
                        if (agentLogUnavailable) return
                        setOpen(open?.kind === "agent" ? null : { kind: "agent" })
                      }}
                      size="compact"
                    >
                      Agent log
                    </Button>
                    <span hidden id="jcf-agent-log-reason">
                      {cancelled ? "The read was cancelled." : "No agent has run yet. Rescan sessions to start one."}
                    </span>
                    <Button disabled={busy || loading} onClick={refreshRecorded} size="compact">
                      Refresh totals
                    </Button>
                    <Button
                      disabled={busy || loading || agentSettingsSaving}
                      onClick={() => {
                        void rescan()
                      }}
                      size="compact"
                    >
                      {missingPlan ? "Scan sessions" : "Rescan sessions"}
                    </Button>
                  </div>
                )
              }
            >
              {agentSettingsOpen ? (
                <Suspense fallback={<p>Loading agent settings…</p>}>
                  <AgentSettingsPanel
                    disabled={busy || loading}
                    onSaved={actions.markConfigurationChanged}
                    onSaving={(saving) => {
                      setAgentSettingsSaving(saving)
                      descriptions.invalidate()
                    }}
                  />
                </Suspense>
              ) : null}
              {plan === null ? (
                <div className="jcf-feedback">{feedback}</div>
              ) : (
                <>
                  <div className="jcf-totals" role="group" aria-label="Week totals">
                    {readFailure === null || readAt === null ? null : (
                      // The alert above says the read failed and why; here the totals are only marked old.
                      <p className="jcf-totals-age">
                        <strong>Totals from {readAt}</strong>
                      </p>
                    )}
                    {plan.scope === "clockify" ? null : (
                      <p aria-label="Jira totals" role="group">
                        <strong>Jira</strong>{" "}
                        {jiraConnected || sources === null ? (
                          <span>{totalLine(totals.jira, totals.jiraSuggested)}</span>
                        ) : (
                          <NotConnected command={sources.jira.connect} />
                        )}
                      </p>
                    )}
                    {plan.scope === "jira" ? null : (
                      <p aria-label="Clockify totals" role="group">
                        <strong>Clockify</strong>{" "}
                        {clockifyConnected || sources === null ? (
                          <span>{totalLine(totals.clockify, totals.clockifySuggested)}</span>
                        ) : (
                          <NotConnected command={sources.clockify.connect} />
                        )}
                      </p>
                    )}
                  </div>
                  <div className="jcf-approval-mode" role="group" aria-labelledby="jcf-approval-label">
                    <span className="jcf-approval-label" id="jcf-approval-label">
                      Suggestions open as
                    </span>
                    <Button
                      size="compact"
                      aria-pressed={!quickApproval}
                      variant={quickApproval ? "secondary" : "primary"}
                      onClick={() => setQuickApproval(false)}
                    >
                      Review first
                    </Button>
                    <Button
                      size="compact"
                      aria-pressed={quickApproval}
                      variant={quickApproval ? "primary" : "secondary"}
                      onClick={() => {
                        setOpen(null)
                        setQuickApproval(true)
                      }}
                    >
                      Quick approve
                    </Button>
                    <span>
                      {quickApproval
                        ? "Click suggestions to queue them. Each one can be undone for 5 seconds before it saves."
                        : "Open a suggestion to adjust its time or note."}
                    </span>
                  </div>
                  <WeekGrid
                    connected={{ jira: jiraConnected, clockify: clockifyConnected }}
                    onOpenSaved={(entry) => {
                      actions.clearWritten()
                      setOpen({ kind: "saved", entry })
                    }}
                    queueUnavailable={state.queueUnavailable}
                    onQuickApprove={(rowId, blockIndex) => {
                      actions.clearWritten()
                      actions.queueConfirm({ rowId, blocks: [blockIndex] })
                    }}
                    layers={state.layers}
                    onToggleLayer={actions.toggleLayer}
                    writing={writing}
                    optimisticEntries={optimisticEntries}
                    disabled={state.queueUnavailable}
                    manualDisabled={unavailable}
                    quickApproval={quickApproval}
                    selectedBlockIndex={open?.kind === "confirm" ? open.blockIndex : undefined}
                    onOpenRow={(rowId, blockIndex) => {
                      actions.clearWritten()
                      if (quickApproval) {
                        actions.queueConfirm({ rowId, blocks: [blockIndex] })
                        return
                      }
                      setOpen({ blockIndex, kind: "confirm", rowId })
                    }}
                    onOpenSlot={(day, clock) => {
                      actions.clearWritten()
                      setOpen({ clock, day, kind: "manual" })
                    }}
                    plan={plan}
                    selectedRowId={open?.kind === "confirm" ? open.rowId : undefined}
                  />
                </>
              )}
            </Region>

            {open === null &&
            plan !== null &&
            !loading &&
            (missingPlan || (plan.rows.length === 0 && plan.unlinkedClockify.length === 0)) ? (
              <aside className="jcf-empty-state" aria-label="Session suggestions">
                {missingPlan && plan.sessionRootCount === 0 ? (
                  <StatePanel
                    title="No session folders chosen"
                    description={`${savedShown} jcf suggests time from coding sessions in folders you choose; run jcf config set session-root with a folder to start.`}
                  />
                ) : missingPlan ? (
                  <StatePanel
                    title="No session suggestions for this week"
                    description={`${savedShown} Scan your coding sessions to add suggestions.`}
                    action={
                      <Button
                        disabled={busy || agentSettingsSaving}
                        onClick={() => void rescan()}
                        size="compact"
                        variant="primary"
                      >
                        Scan sessions
                      </Button>
                    }
                  />
                ) : (
                  <StatePanel
                    title="No logged or proposed time this week"
                    description="Choose another week or use Log time for work away from your coding sessions."
                  />
                )}
              </aside>
            ) : open === null && plan !== null ? (
              <aside className="jcf-guide" aria-label="Calendar help">
                <Region title="Nothing selected">
                  <p>
                    Open a dashed suggestion to review and log it, or a saved entry to edit it. Click empty time to log
                    work your sessions did not record.
                  </p>
                  <p>Use + on a suggestion to approve it at once. You can undo it for 5 seconds before it saves.</p>
                  <p>
                    Overlap is checked against the Jira and Clockify layers you show, with or without a ticket. New time
                    is written only to the layers you show.
                  </p>
                </Region>
              </aside>
            ) : null}

            {sheetOpen ? (
              <div
                aria-hidden="true"
                className="jcf-scrim"
                onClick={() => {
                  if (open?.kind === "agent" || !writing) setOpen(null)
                }}
              />
            ) : null}
            {open === null ? null : (
              <EditorFrame
                notice={plan === null ? undefined : feedback}
                // The conversation stays put while the read's progress comes and goes below it.
                noticeAt={open.kind === "agent" ? "end" : "start"}
                busy={open.kind === "agent" ? false : writing}
                label={
                  open.kind === "agent"
                    ? "Agent conversation"
                    : open.kind === "saved"
                      ? "Saved time editor"
                      : "Time entry editor"
                }
                onClose={() => setOpen(null)}
                identity={JSON.stringify(open)}
              >
                {open.kind === "saved" && plan !== null ? (
                  <SavedEntryPanel
                    key={`${plan.planId}:${open.entry.source}:${open.entry.id}`}
                    entry={open.entry}
                    targetVisible={state.writeTargets[open.entry.source]}
                    planId={plan.planId}
                    busy={writing}
                    unavailable={unavailable}
                    descriptionDisabled={agentSettingsSaving}
                    onSave={(request) => closeAfter(actions.updateSaved({ entry: open.entry, request }))}
                    onDelete={() =>
                      closeAfter(
                        actions.deleteSaved({
                          planId: plan.planId,
                          source: open.entry.source,
                          entryId: open.entry.id,
                          revision: open.entry.revision
                        })
                      )
                    }
                    onCancel={() => setOpen(null)}
                  />
                ) : null}
                {open.kind === "agent" ? (
                  <>
                    <div className="jcf-conversation-heading">
                      <h2>Agent conversation</h2>
                      <Button onClick={() => setOpen(null)} size="compact" variant="quiet">
                        Close
                      </Button>
                    </div>
                    <AgentTerminal
                      key={startedAt}
                      activity={activity}
                      ended={readFailure !== null ? "failed" : cancelled ? "cancelled" : null}
                    />
                    {/* Below the conversation, so it can come and go without moving what is being read. */}
                    {loading && readMode === "full" ? (
                      <>
                        <ReadStatus
                          key={startedAt}
                          progress={progress}
                          startedAt={startedAt}
                          onCancel={cancel}
                          mode={readMode}
                        />
                        {plan === null ? null : (
                          <p className="jcf-muted">Showing the last loaded week while the new read runs.</p>
                        )}
                      </>
                    ) : null}
                  </>
                ) : null}
                {openRow === undefined || open?.kind !== "confirm" || plan === null ? null : (
                  <ConfirmPanel
                    description={descriptions.get(plan.planId, openRow.rowId)}
                    descriptionDisabled={agentSettingsSaving}
                    blockIndex={open.blockIndex}
                    busy={writing}
                    unavailable={unavailable}
                    // Each clicked block starts a fresh editor.
                    key={`${openRow.rowId}:${open.blockIndex}`}
                    onCancel={() => setOpen(null)}
                    onConfirm={(submission) => confirm(submission, openRow.rowId)}
                    onIgnore={() => closeAfter(actions.setIgnored({ ticketKey: openRow.ticketKey, ignored: true }))}
                    row={openRow}
                    scopeTargets={state.writeTargets}
                  />
                )}

                {open?.kind === "manual" ? (
                  <ManualPanel
                    busy={busy}
                    key={`${open.day}:${open.clock}`}
                    days={plan?.days ?? [open.day]}
                    day={open.day}
                    onCancel={() => setOpen(null)}
                    onLog={(submission) => closeAfter(actions.logManual(submission))}
                    scopeTargets={state.writeTargets}
                    startClock={open.clock}
                  />
                ) : null}
              </EditorFrame>
            )}
          </div>

          {plan === null ? null : (
            <div className="jcf-lanes" inert={sheetOpen}>
              {plan.withheld.length === 0 ? null : (
                <Region className="jcf-lane" count={plan.withheld.length} title="Low-confidence matches">
                  <p className="jcf-muted">
                    The agent's pick for these sessions fell below your confidence floor, so they are not suggested.
                  </p>
                  <ul>
                    {plan.withheld.map((row) => (
                      <li key={`${row.day}:${row.ticketKey}`}>
                        <strong>{row.day}</strong>
                        <span>{row.ticketKey}</span>
                        <span>{duration(row.seconds)}</span>
                        <span className="jcf-muted">
                          {row.confidence === null ? "no confidence" : `confidence ${row.confidence.toFixed(2)}`}
                          {row.ticketTitle === null ? "" : `, ${row.ticketTitle}`}
                        </span>
                        <Button
                          disabled={unavailable}
                          onClick={() =>
                            void actions.promoteWithheld({
                              planId: plan.planId,
                              ticketKey: row.ticketKey,
                              day: row.day
                            })
                          }
                          size="compact"
                          variant="quiet"
                        >
                          {`Log as ${row.ticketKey}`}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Region>
              )}
              {ignoredTotals.length === 0 ? null : (
                <Region className="jcf-lane" count={ignoredTotals.length} title="Ignored tickets">
                  <p className="jcf-muted">
                    Not suggested in any week. Where they ran alongside other tickets, those tickets took the time.
                  </p>
                  <ul>
                    {ignoredTotals.map((ignored) => (
                      <li key={ignored.ticketKey}>
                        <strong>{ignored.ticketKey}</strong>
                        <span>
                          {ignored.seconds === 0 ? "no time this week" : `${duration(ignored.seconds)} this week`}
                        </span>
                        <Button
                          disabled={unavailable}
                          onClick={() => void actions.setIgnored({ ticketKey: ignored.ticketKey, ignored: false })}
                          size="compact"
                          variant="quiet"
                        >
                          Restore
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Region>
              )}
              {plan.notMine.length === 0 ? null : (
                <Region className="jcf-lane" count={plan.notMine.length} title="Assigned to somebody else">
                  <p className="jcf-muted">
                    A branch cannot tell writing a ticket from reviewing one. These hours are real; they are just not
                    offered, because Jira says the ticket is not yours. If one of them is your work, say so once and it
                    stays said.
                  </p>
                  <ul>
                    {plan.notMine.map((row) => (
                      <li key={`${row.day}:${row.ticketKey}`}>
                        <strong>{row.day}</strong>
                        <span>{row.ticketKey}</span>
                        <span>{duration(row.seconds)}</span>
                        {row.ticketTitle === null ? null : <span className="jcf-muted">{row.ticketTitle}</span>}
                        <span className="jcf-muted">{row.assignee === null ? "unassigned" : row.assignee}</span>
                        <Button
                          disabled={unavailable}
                          onClick={() => closeAfter(actions.markMine({ ticketKey: row.ticketKey }))}
                          size="compact"
                          variant="quiet"
                        >
                          It is mine
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Region>
              )}

              {plan.excludedDays.length === 0 ? null : (
                <Region className="jcf-lane" count={plan.excludedDays.length} title="Days held back">
                  <ul>
                    {plan.excludedDays.map((excluded) => (
                      <li key={excluded.day}>
                        <strong>{excluded.day}</strong>
                        <span className="jcf-muted">{excluded.reason}</span>
                      </li>
                    ))}
                  </ul>
                </Region>
              )}
            </div>
          )}
        </main>
      </PortalProvider>
    </ThemeProvider>
  )
}
