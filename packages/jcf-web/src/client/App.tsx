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

/** `1h 0m saved, 30m suggested`; a zero reads as "nothing" rather than `0s`. */
const totalLine = (savedSeconds: number, suggestedSeconds: number): string =>
  `${savedSeconds > 0 ? formatDuration(savedSeconds) : "nothing"} saved, ${
    suggestedSeconds > 0 ? formatDuration(suggestedSeconds) : "nothing"
  } suggested`

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
  const agentLogUnavailable = (activity.length === 0 && !loading) || cancelled
  const writeIncomplete = incompleteWrite(written)
  const { chooseScope, refreshRecorded } = actions
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [agentSettingsSaving, setAgentSettingsSaving] = useState(false)
  const [quickApproval, setQuickApproval] = useState(false)
  const [open, setOpen] = useState<OpenPanel | null>(null)
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

  return (
    <ThemeProvider className="jcf-shell" theme={theme}>
      <PortalProvider>
        <main className="jcf-app">
          <header className="jcf-masthead">
            <Text as="h1" variant="section-title">
              Jira and Clockify week
            </Text>
            <p className="jcf-read-at">
              {loading
                ? "Reading the week…"
                : readFailure !== null
                  ? "Last read failed"
                  : readAt === null
                    ? "Not read yet"
                    : `Read at ${readAt}`}
            </p>
            <ThemeSelect labelVisibility="hidden" onValueChange={setTheme} value={theme} />
          </header>
          <div className="jcf-bar" role="toolbar" aria-label="Week controls">
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
            <div className="jcf-bar-group jcf-bar-actions" role="group" aria-label="Sessions and logging">
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
                Agent requests and responses
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
            </div>
          </div>
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
          {configurationChanged ? (
            <p className="jcf-note">Setting saved. Choose Rescan sessions to update the suggestions.</p>
          ) : null}
          {plan !== null && open !== null ? null : (
            <div className="jcf-feedback" data-floating={plan !== null && (readMode === "recorded" || !loading)}>
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
            {plan === null ? null : (
              <Region className="jcf-week-region" title={weekLabel(plan.days)}>
                <div className="jcf-totals" role="group" aria-label="Week totals">
                  {plan.scope === "clockify" ? null : (
                    <p aria-label="Jira totals" role="group">
                      <strong>Jira</strong> <span>{totalLine(totals.jira, totals.jiraSuggested)}</span>
                    </p>
                  )}
                  {plan.scope === "jira" ? null : (
                    <p aria-label="Clockify totals" role="group">
                      <strong>Clockify</strong> <span>{totalLine(totals.clockify, totals.clockifySuggested)}</span>
                    </p>
                  )}
                </div>
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
                    Quick approve
                  </Button>
                  <span>
                    {quickApproval
                      ? "Click suggestions to queue them. Each one can be undone for 5 seconds before it saves."
                      : "Open a suggestion to adjust its time or note."}
                  </span>
                </div>
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
              </Region>
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

            {open === null ? null : (
              <EditorFrame
                notice={plan === null ? undefined : feedback}
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
            <div className="jcf-lanes">
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
