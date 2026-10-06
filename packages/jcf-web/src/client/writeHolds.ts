import type { WeekPlanResponse } from "../shared/contracts.js"

/**
 * Providers held for manual review anywhere in the week, in display order.
 *
 * A held provider's suggestions have no writable minutes, so the calendar draws none of them; this
 * is what keeps a fully held week from looking like a week with nothing to log.
 */
export const heldWriteProviders = (plan: WeekPlanResponse | null): ReadonlyArray<"Jira" | "Clockify"> => {
  const rows = plan?.rows ?? []
  const providers: ReadonlyArray<{ readonly key: "jira" | "clockify"; readonly name: "Jira" | "Clockify" }> = [
    { key: "jira", name: "Jira" },
    { key: "clockify", name: "Clockify" }
  ]
  return providers
    .filter(({ key }) => rows.some((row) => row.proposal?.writeBlocked?.[key] !== undefined))
    .map(({ name }) => name)
}

/**
 * Every ignored ticket with its evidenced time this week, by ticket. A ticket ignored from an
 * agent-only match can have no evidence this week and still appears, at zero, so it stays restorable.
 */
export const ignoredTicketTotals = (
  plan: WeekPlanResponse | null
): ReadonlyArray<{ readonly ticketKey: string; readonly seconds: number }> => {
  const totals = new Map<string, number>((plan?.ignoredTickets ?? []).map((key) => [key, 0]))
  for (const row of plan?.ignored ?? []) totals.set(row.ticketKey, (totals.get(row.ticketKey) ?? 0) + row.seconds)
  return [...totals].map(([ticketKey, seconds]) => ({ ticketKey, seconds })).sort((a, b) =>
    a.ticketKey.localeCompare(b.ticketKey)
  )
}

/**
 * The week as it reads right after an ignore decision, before a rescan recomputes it.
 *
 * Ignoring hides the ticket's suggestions at once — waiting minutes for a rescan to make a click do
 * something reads as a broken button. Its active time stands in for the ignored total until the
 * rescan reports the exact figure and hands its parallel minutes to the other tickets. Restoring
 * cannot bring suggestions back without a rescan, so it only updates the list.
 */
export const withIgnoreDecision = (
  plan: WeekPlanResponse,
  ticketKey: string,
  ignoredTickets: ReadonlyArray<string>
): WeekPlanResponse => {
  const ignoring = ignoredTickets.includes(ticketKey)
  if (!ignoring) {
    return { ...plan, ignoredTickets, ignored: plan.ignored.filter((row) => row.ticketKey !== ticketKey) }
  }
  const hidden = plan.rows.flatMap((row) =>
    row.ticketKey === ticketKey && row.proposal !== undefined
      ? [{ ticketKey, day: row.day, seconds: row.proposal.activeSeconds }]
      : []
  )
  return {
    ...plan,
    ignoredTickets,
    ignored: [...plan.ignored.filter((row) => row.ticketKey !== ticketKey), ...hidden],
    rows: plan.rows.map((row) => row.ticketKey === ticketKey ? { ...row, proposal: undefined } : row)
  }
}
