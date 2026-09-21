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
import { ThemeProvider } from "@knpkv/rly/foundations"
import { RegistryContext } from "@effect/atom-react"
import { Button, StatePanel, Text } from "@knpkv/rly/primitives"
import { lazy, Suspense, useContext, useEffect, useMemo, useState } from "react"
import type { WeekScopeName } from "../server/Api.js"
import type { ConfirmRequest } from "./api.js"
import { useWeek } from "./useWeek.js"
import { AgentTerminal } from "./AgentTerminal.js"
import { ReadStatus } from "./ReadStatus.js"
import { EditorFrame } from "./EditorFrame.js"
import { duration, formatClock, formatDuration, shiftWeek, weekLabel } from "./format.js"
import { ConfirmPanel, ManualPanel } from "./panels.js"
import { weekTotals } from "./calendarProjection.js"
import { WeekGrid } from "./WeekGrid.js"
import { makeRowDescriptions } from "./rowDescriptions.js"
import { SavedEntryPanel } from "./SavedEntryPanel.js"
import type { SavedEntry, WriteResultResponse } from "../shared/contracts.js"

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

/** A successful segment does not make a partially failed approval complete. */
const incompleteWrite = (result: WriteResultResponse | null): boolean =>
  result !== null &&
  [result.clockify, result.jira].some(
    (outcome) => outcome._tag === "Refused" || outcome._tag === "NotLoggedIn" || outcome._tag === "PartiallyWritten"
  )

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
    startedAt,
    unavailable,
    written
  } = state
  const busy = writing || state.queueActive
  const writeIncomplete = incompleteWrite(written)
  const { chooseScope, refreshRecorded } = actions
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [agentSettingsSaving, setAgentSettingsSaving] = useState(false)
  const [quickApproval, setQuickApproval] = useState(false)
  const [open, setOpen] = useState<OpenPanel | null>(null)
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system")
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

  const closeAfter = async (result: Promise<boolean>) => {
    if (await result) setOpen(null)
  }

  const confirm = (request: Omit<ConfirmRequest, "planId" | "rowId">, rowId: string) =>
    closeAfter(actions.confirm({ ...request, rowId }))

  return (
    <ThemeProvider className="jcf-shell" theme={theme}>
      <main className="jcf-app">
        <header className="jcf-heading">
          <div>
            <Text as="h1" variant="section-title">
              JCF
            </Text>
            <Text as="p" tone="secondary">
              Your week in Jira and Clockify.
            </Text>
          </div>
          <label className="jcf-theme">
            Appearance
            <select
              aria-label="Appearance"
              value={theme}
              onChange={(event) => {
                const value = event.target.value
                if (value === "light" || value === "dark" || value === "system") setTheme(value)
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </header>
        <header className="jcf-bar">
          <div className="jcf-week-nav">
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
          <div className="jcf-scope" role="group" aria-label="Systems to reconcile">
            {scopeLabels.map((option) => (
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
            disabled={(activity.length === 0 && !loading) || cancelled}
            onClick={() => setOpen(open?.kind === "agent" ? null : { kind: "agent" })}
            size="compact"
          >
            Agent requests and responses
          </Button>
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
            Rescan sessions
          </Button>
          <Button
            disabled={unavailable}
            onClick={() => {
              if (plan !== null) setOpen({ kind: "manual", day: plan.monday, clock: "09:00" })
            }}
            size="compact"
            variant="primary"
          >
            Log time
          </Button>
        </header>
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
        <div className="jcf-week-summary">
          <Text as="h2" variant="card-title">
            {plan === null ? "Your week" : weekLabel(plan.days)}
          </Text>
          <div className="jcf-totals">
            {plan?.scope === "clockify" ? null : (
              <div aria-label="Jira totals" data-source="jira">
                <span>
                  Jira <strong>{formatDuration(totals.jira)} saved</strong>
                </span>
                <span className="jcf-muted">+{formatDuration(totals.jiraSuggested)} suggested</span>
              </div>
            )}
            {plan?.scope === "jira" ? null : (
              <div aria-label="Clockify totals" data-source="clockify">
                <span>
                  Clockify <strong>{formatDuration(totals.clockify)} saved</strong>
                </span>
                <span className="jcf-muted">+{formatDuration(totals.clockifySuggested)} suggested</span>
              </div>
            )}
          </div>
        </div>
        {configurationChanged ? (
          <p className="jcf-note">Setting saved. Choose Rescan sessions to update the suggestions.</p>
        ) : null}
        <div
          className="jcf-feedback"
          data-editing={open !== null}
          data-floating={plan !== null && (readMode === "recorded" || !loading)}
        >
          {loading && readMode === "recorded" ? (
            <ReadStatus key={startedAt} progress={progress} startedAt={startedAt} onCancel={cancel} mode={readMode} />
          ) : null}
          {readFailure === null ? null : (
            <StatePanel
              announce="assertive"
              title={readMode === "recorded" ? "Could not update logged time" : "Could not load the week"}
              description={readFailure}
              tone="critical"
              action={
                <Button disabled={agentSettingsSaving} onClick={retry} size="compact">
                  {readMode === "full" ? "Rescan sessions" : "Retry read"}
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
            <StatePanel
              announce="assertive"
              title="Could not complete the action"
              description={failure}
              tone="critical"
            />
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
        </div>
        {plan !== null && plan.sessionRootCount === 0 ? (
          <p className="jcf-note" data-tone="warning">
            No Session Root is configured, so no session can become a proposal. Run{" "}
            <code>jcf config set session-root ~/dev/work</code>.
          </p>
        ) : null}
        {plan !== null && plan.ownership === "assigned" && !plan.ownershipChecked ? (
          <p className="jcf-note" data-tone="warning">
            {plan.scope === "clockify"
              ? "Clockify only, so Jira was not asked who owns these tickets — nothing is withheld and no titles are shown."
              : "Jira could not say who owns these tickets, so nothing was withheld on ownership this week."}
          </p>
        ) : null}
        {plan !== null && !plan.attributorAvailable ? (
          <p className="jcf-note" data-tone="warning">
            A Coding Agent could not be reached. Sessions without a branch or path match have no suggestions.
          </p>
        ) : null}

        {plan === null ? null : (
          <div className="jcf-approval-mode" role="group" aria-label="Suggestion approval mode">
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
              Quick approve · 5s Undo
            </Button>
            <span>
              {quickApproval
                ? "Click suggestions to queue them. Keep going while they save."
                : "Open a suggestion to adjust its time or note."}
            </span>
          </div>
        )}
        {state.queued.length === 0 ? null : (
          <section className="jcf-approval-queue" aria-label="Approval queue">
            <p role="status">
              {state.queued.length} approval{state.queued.length === 1 ? "" : "s"} pending. Undo is available until
              saving starts.
            </p>
            <ul role="list">
              {state.queued.map((entry) => {
                const label = `${entry.ticketKey} · ${entry.day} · ${formatClock(new Date(entry.startMs))}–${formatClock(new Date(entry.endMs))}`
                return (
                  <li key={entry.id}>
                    <span>{label}</span>
                    {entry.status === "saving" ? (
                      <span>Saving…</span>
                    ) : (
                      <Button size="compact" aria-label={`Undo ${label}`} onClick={() => actions.undoQueued(entry.id)}>
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
          {plan === null ? null : (
            <WeekGrid
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
          )}

          {open === null &&
          plan !== null &&
          !loading &&
          (missingPlan || (plan.rows.length === 0 && plan.unlinkedClockify.length === 0)) ? (
            <aside className="jcf-empty-state" aria-label="Session suggestions">
              {missingPlan ? (
                <StatePanel
                  title="No session suggestions for this week"
                  description="Saved Jira and Clockify time is shown. Scan your coding sessions to add suggestions."
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
          ) : null}

          {open === null ? null : (
            <EditorFrame
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
                  <AgentTerminal key={startedAt} activity={activity} />
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
          <div className="jcf-lanes">
            {plan.notMine.length === 0 ? null : (
              <section className="jcf-lane">
                <h2>Assigned to somebody else</h2>
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
              </section>
            )}

            {plan.excludedDays.length === 0 ? null : (
              <section className="jcf-lane">
                <h2>Days held back</h2>
                <ul>
                  {plan.excludedDays.map((excluded) => (
                    <li key={excluded.day}>
                      <strong>{excluded.day}</strong>
                      <span className="jcf-muted">{excluded.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </ThemeProvider>
  )
}
