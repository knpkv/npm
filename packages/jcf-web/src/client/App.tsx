/**
 * A week of time, and the gaps in it.
 *
 * **Mental model**
 *
 * - **Allocated and proposable in one cell.** A gap only means something next to what is already
 *   there, which is the whole reason this is a grid and not a list of proposals.
 * - **The server owns every number.** This component chooses what to show and what to ask; it never
 *   computes hours, never sizes a write, and never decides what is safe.
 * - **Three lanes under the grid, none of them decoration.** Hours a Coding Agent placed too weakly
 *   to offer, hours nothing placed at all, and days withheld because a Timer is still running. Each
 *   one is time that exists and is not in the grid, so hiding it would make the grid a lie.
 *
 * @module
 */
import { Button, ThemeProvider } from "@knpkv/rly"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { WeekPlanResponse, WeekScopeName, WriteResultResponse, WriteTargetsRequest } from "../server/Api.js"
import {
  bootstrapSession,
  confirmRow,
  type ConfirmRequest,
  logManual,
  mapStandingAttribution,
  RequestFailure
} from "./api.js"
import { readWeek } from "./api.js"
import { duration, shiftWeek, weekLabel } from "./format.js"
import { ConfirmPanel, ManualPanel, StandingPanel } from "./panels.js"
import { WeekGrid } from "./WeekGrid.js"

type OpenPanel =
  | { readonly kind: "confirm"; readonly rowId: string }
  | { readonly kind: "manual"; readonly day: string; readonly clock: string }
  | { readonly kind: "standing"; readonly day: string; readonly cwd: string }

const scopeStorageKey = "jcf_web_scope"

/** Which systems a scope name writes to. */
const targetsOfScope = (scope: WeekScopeName): WriteTargetsRequest => ({
  clockify: scope !== "jira",
  jira: scope !== "clockify"
})

/** Remembered per browser: someone who tracks in one system does so every week. */
const storedScope = (): WeekScopeName => {
  try {
    const stored = window.localStorage.getItem(scopeStorageKey)
    return stored === "clockify" || stored === "jira" ? stored : "both"
  } catch {
    return "both"
  }
}

const rememberScope = (scope: WeekScopeName): void => {
  try {
    window.localStorage.setItem(scopeStorageKey, scope)
  } catch {
    // Storage is unavailable; the choice lasts this page.
  }
}

const scopeLabels: ReadonlyArray<{ readonly scope: WeekScopeName; readonly label: string }> = [
  { label: "Both", scope: "both" },
  { label: "Jira only", scope: "jira" },
  { label: "Clockify only", scope: "clockify" }
]

const messageOf = (error: unknown): string =>
  error instanceof RequestFailure || error instanceof Error ? error.message : String(error)

export const App = () => {
  const [monday, setMonday] = useState<string | undefined>(undefined)
  const [scope, setScope] = useState<WeekScopeName>(storedScope)
  const [plan, setPlan] = useState<WeekPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [written, setWritten] = useState<WriteResultResponse | null>(null)
  const [open, setOpen] = useState<OpenPanel | null>(null)

  const load = useCallback(async (week: string | undefined, which: WeekScopeName) => {
    setLoading(true)
    setFailure(null)
    try {
      const next = await readWeek(week, which)
      setPlan(next)
      setMonday(next.monday)
      setOpen(null)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // The session first: every read below depends on it, and a page opened without a bootstrap
    // fragment relies on the cookie a previous load stored.
    bootstrapSession()
      .catch((error: unknown) => setFailure(messageOf(error)))
      .then(() => load(undefined, storedScope()))
  }, [load])

  const openRow = useMemo(
    () => (open?.kind === "confirm" ? plan?.rows.find((row) => row.rowId === open.rowId) : undefined),
    [open, plan]
  )

  const totals = useMemo(() => {
    let logged = 0
    let proposable = 0
    for (const row of plan?.rows ?? []) {
      logged += Math.max(row.clockifySeconds, row.jiraSeconds)
      proposable += Math.max(row.proposal?.clockifyDelta ?? 0, row.proposal?.jiraDelta ?? 0)
    }
    return { logged, proposable }
  }, [plan])

  const afterWrite = async (result: WriteResultResponse) => {
    setWritten(result)
    setOpen(null)
    await load(monday, scope)
  }

  const chooseScope = (next: WeekScopeName) => {
    setScope(next)
    rememberScope(next)
    void load(monday, next)
  }

  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailure(null)
    setWritten(null)
    try {
      await action()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const confirm = (request: Omit<ConfirmRequest, "planId" | "rowId">, rowId: string) =>
    act(async () => {
      if (plan === null) return
      await afterWrite(await confirmRow({ ...request, planId: plan.planId, rowId }))
    })

  return (
    <ThemeProvider className="jcf-shell" theme="system">
      <header className="jcf-bar">
        <h1>{plan === null ? "Week" : weekLabel(plan.days)}</h1>
        <Button
          disabled={loading || monday === undefined}
          onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, -1), scope)}
        >
          ← Previous
        </Button>
        <Button disabled={loading} onClick={() => load(undefined, scope)}>
          This week
        </Button>
        <Button
          disabled={loading || monday === undefined}
          onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, 1), scope)}
        >
          Next →
        </Button>
        <span className="jcf-bar-spacer" />
        {/* A side that is out is not read, not proposed for, and not written to. */}
        <span className="jcf-scope" role="group">
          {scopeLabels.map((option) => (
            <Button
              disabled={loading}
              key={option.scope}
              onClick={() => chooseScope(option.scope)}
              size="compact"
              variant={option.scope === scope ? "primary" : "quiet"}
            >
              {option.label}
            </Button>
          ))}
        </span>
        <span className="jcf-totals">
          <span>Logged {duration(totals.logged)}</span>
          <span>Proposable {duration(totals.proposable)}</span>
        </span>
      </header>

      {failure === null ? null : (
        <p className="jcf-note" data-tone="failure">
          {failure}
        </p>
      )}
      {written === null ? null : (
        <div className="jcf-note" data-tone="success">
          <p>{written.lines.join(" · ")}</p>
          <p className="jcf-preview">{written.description}</p>
        </div>
      )}
      {plan !== null && plan.sessionRootCount === 0 ? (
        <p className="jcf-note" data-tone="warning">
          No Session Root is configured, so no session can become a proposal. Run{" "}
          <code>jcf config set session-root ~/dev/work</code>.
        </p>
      ) : null}
      {plan !== null && !plan.attributorAvailable ? (
        <p className="jcf-note" data-tone="warning">
          A Coding Agent could not be reached, so sessions no branch or path could place are only reported below.
        </p>
      ) : null}

      {loading && plan === null ? <p className="jcf-muted">Reading sessions…</p> : null}

      {plan === null ? null : (
        <WeekGrid
          onOpenRow={(rowId) => {
            setWritten(null)
            setOpen({ kind: "confirm", rowId })
          }}
          onOpenSlot={(day, clock) => {
            setWritten(null)
            setOpen({ clock, day, kind: "manual" })
          }}
          plan={plan}
          selectedRowId={open?.kind === "confirm" ? open.rowId : undefined}
        />
      )}

      {openRow === undefined ? null : (
        <ConfirmPanel
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(submission) =>
            confirm(
              {
                targets: submission.targets,
                ...(submission.note === undefined ? {} : { note: submission.note }),
                ...(submission.seconds === undefined ? {} : { seconds: submission.seconds }),
                ...(submission.ticketKey === undefined ? {} : { ticketKey: submission.ticketKey })
              },
              openRow.rowId
            )
          }
          row={openRow}
          scopeTargets={targetsOfScope(scope)}
        />
      )}

      {open?.kind === "manual" ? (
        <ManualPanel
          busy={busy}
          day={open.day}
          onCancel={() => setOpen(null)}
          onLog={(submission) =>
            act(async () => {
              await afterWrite(
                await logManual({
                  day: open.day,
                  seconds: submission.seconds,
                  targets: submission.targets,
                  ticketKey: submission.ticketKey,
                  ...(submission.note === undefined ? {} : { note: submission.note }),
                  ...(submission.startClock === undefined ? {} : { startClock: submission.startClock })
                })
              )
            })
          }
          scopeTargets={targetsOfScope(scope)}
          startClock={open.clock}
        />
      ) : null}

      {open?.kind === "standing" && plan !== null ? (
        <StandingPanel
          busy={busy}
          credit={
            plan.unattributed.find((credit) => credit.day === open.day) ?? {
              cwds: [],
              day: open.day,
              seconds: 0,
              sessionCount: 0
            }
          }
          cwd={open.cwd}
          onCancel={() => setOpen(null)}
          onMap={(mapping) =>
            act(async () => {
              await mapStandingAttribution(mapping)
              await load(monday, scope)
            })
          }
        />
      ) : null}

      {plan === null ? null : (
        <div className="jcf-lanes">
          {plan.unattributed.length === 0 ? null : (
            <section className="jcf-lane">
              <h2>Nothing placed these hours</h2>
              <ul>
                {plan.unattributed.map((credit) => (
                  <li key={credit.day}>
                    <strong>{credit.day}</strong>
                    <span>{duration(credit.seconds)}</span>
                    <span className="jcf-muted">
                      {credit.sessionCount} session{credit.sessionCount === 1 ? "" : "s"}
                    </span>
                    {credit.cwds.map((cwd) => (
                      <Button
                        key={cwd}
                        onClick={() => setOpen({ cwd, day: credit.day, kind: "standing" })}
                        size="compact"
                        variant="quiet"
                      >
                        {cwd}
                      </Button>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.withheld.length === 0 ? null : (
            <section className="jcf-lane">
              <h2>Placed too weakly to offer</h2>
              <ul>
                {plan.withheld.map((credit) => (
                  <li key={`${credit.day}:${credit.ticketKey}`}>
                    <strong>{credit.day}</strong>
                    <span>{credit.ticketKey}</span>
                    <span>{duration(credit.seconds)}</span>
                    <span className="jcf-muted">
                      confidence {credit.confidence === null ? "unknown" : credit.confidence.toFixed(2)} — below the
                      floor, so it is reported rather than proposed
                    </span>
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
    </ThemeProvider>
  )
}
