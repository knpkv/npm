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
import type { WeekPlanResponse, WeekRowResponse, WriteResultResponse } from "../server/Api.js"
import {
  bootstrapSession,
  confirmRow,
  type ConfirmRequest,
  logManual,
  mapStandingAttribution,
  RequestFailure
} from "./api.js"
import { readWeek } from "./api.js"
import { dayHeading, duration, shiftWeek, weekLabel } from "./format.js"
import { ConfirmPanel, ManualPanel, StandingPanel } from "./panels.js"

type OpenPanel =
  | { readonly kind: "confirm"; readonly rowId: string }
  | { readonly kind: "manual"; readonly day: string }
  | { readonly kind: "standing"; readonly day: string; readonly cwd: string }

const messageOf = (error: unknown): string =>
  error instanceof RequestFailure || error instanceof Error ? error.message : String(error)

/** Allocated time in one cell: one figure when the two systems agree, both when they do not. */
const Allocated = (props: { readonly row: WeekRowResponse | undefined }) => {
  if (props.row === undefined)
    return (
      <span className="jcf-allocated" data-empty="true">
        —
      </span>
    )
  const { clockifySeconds, jiraSeconds } = props.row
  if (clockifySeconds === jiraSeconds) {
    return (
      <span className="jcf-allocated" data-empty={clockifySeconds === 0 ? "true" : "false"}>
        {duration(clockifySeconds)}
      </span>
    )
  }
  // The two disagreeing is the original problem this tool exists for, so it is shown rather than
  // reduced to one number.
  return (
    <span className="jcf-allocated">
      {duration(clockifySeconds)}
      <span className="jcf-split"> C / {duration(jiraSeconds)} J</span>
    </span>
  )
}

export const App = () => {
  const [monday, setMonday] = useState<string | undefined>(undefined)
  const [plan, setPlan] = useState<WeekPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [written, setWritten] = useState<WriteResultResponse | null>(null)
  const [open, setOpen] = useState<OpenPanel | null>(null)

  const load = useCallback(async (week: string | undefined) => {
    setLoading(true)
    setFailure(null)
    try {
      const next = await readWeek(week)
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
      .then(() => load(undefined))
  }, [load])

  const rowsByTicket = useMemo(() => {
    const grouped = new Map<string, Map<string, WeekRowResponse>>()
    for (const row of plan?.rows ?? []) {
      const byDay = grouped.get(row.ticketKey) ?? new Map<string, WeekRowResponse>()
      byDay.set(row.day, row)
      grouped.set(row.ticketKey, byDay)
    }
    return grouped
  }, [plan])

  const openRow = useMemo(
    () => (open?.kind === "confirm" ? plan?.rows.find((row) => row.rowId === open.rowId) : undefined),
    [open, plan]
  )

  const totals = useMemo(() => {
    let allocated = 0
    let proposable = 0
    for (const row of plan?.rows ?? []) {
      allocated += Math.max(row.clockifySeconds, row.jiraSeconds)
      proposable += Math.max(row.proposal?.clockifyDelta ?? 0, row.proposal?.jiraDelta ?? 0)
    }
    return { allocated, proposable }
  }, [plan])

  const afterWrite = async (result: WriteResultResponse) => {
    setWritten(result)
    setOpen(null)
    await load(monday)
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
          onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, -1))}
        >
          ← Previous
        </Button>
        <Button disabled={loading} onClick={() => load(undefined)}>
          This week
        </Button>
        <Button
          disabled={loading || monday === undefined}
          onClick={() => load(monday === undefined ? undefined : shiftWeek(monday, 1))}
        >
          Next →
        </Button>
        <span className="jcf-bar-spacer" />
        <span className="jcf-totals">
          <span>Allocated {duration(totals.allocated)}</span>
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
        <div className="jcf-grid-scroll">
          <table className="jcf-grid">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                {plan.days.map((day) => {
                  const heading = dayHeading(day)
                  return (
                    <th key={day} scope="col">
                      <span className="jcf-day-heading">
                        <span>{heading.weekday}</span>
                        <span className="jcf-date">{heading.date}</span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {[...rowsByTicket.entries()].map(([ticketKey, byDay]) => (
                <tr key={ticketKey}>
                  <th scope="row">{ticketKey}</th>
                  {plan.days.map((day) => {
                    const row = byDay.get(day)
                    const proposal = row?.proposal
                    return (
                      <td key={day}>
                        <span className="jcf-cell">
                          <Allocated row={row} />
                          {row !== undefined && proposal !== undefined ? (
                            <button
                              className="jcf-gap"
                              data-selected={open?.kind === "confirm" && open.rowId === row.rowId}
                              onClick={() => {
                                setWritten(null)
                                setOpen({ kind: "confirm", rowId: row.rowId })
                              }}
                              type="button"
                            >
                              <span>+{duration(Math.max(proposal.clockifyDelta, proposal.jiraDelta))}</span>
                              <span className="jcf-signal" data-signal={proposal.signal}>
                                {proposal.signal}
                              </span>
                            </button>
                          ) : null}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr>
                <th scope="row">By hand</th>
                {plan.days.map((day) => (
                  <td key={day}>
                    <Button
                      onClick={() => {
                        setWritten(null)
                        setOpen({ day, kind: "manual" })
                      }}
                      size="compact"
                      variant="quiet"
                    >
                      + time
                    </Button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {openRow === undefined ? null : (
        <ConfirmPanel
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(submission) =>
            confirm(
              {
                ...(submission.note === undefined ? {} : { note: submission.note }),
                ...(submission.seconds === undefined ? {} : { seconds: submission.seconds }),
                ...(submission.ticketKey === undefined ? {} : { ticketKey: submission.ticketKey })
              },
              openRow.rowId
            )
          }
          row={openRow}
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
                  ticketKey: submission.ticketKey,
                  ...(submission.note === undefined ? {} : { note: submission.note }),
                  ...(submission.startClock === undefined ? {} : { startClock: submission.startClock })
                })
              )
            })
          }
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
              await load(monday)
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
