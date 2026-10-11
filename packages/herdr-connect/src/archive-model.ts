import { type ArchivedConnectAgent, type ConnectArchivePage, connectArchiveWindowDays } from "./model.js"

/** A reopening shares the live ID; each retained closure has its own identity. */
export const archivedAgentKey = (agent: ArchivedConnectAgent): string =>
  JSON.stringify([agent.host, agent.agentId, agent.closedAt])

/** Append in the server's newest-first page order, retaining one row per exact closure. */
export const appendArchivePage = (loaded: ConnectArchivePage | null, next: ConnectArchivePage): ConnectArchivePage => ({
  agents: [
    ...new Map([...(loaded?.agents ?? []), ...next.agents].map((agent) => [archivedAgentKey(agent), agent])).values()
  ],
  nextCursor: next.nextCursor
})

/** A cursor means the loaded count is a lower bound, never an archive-wide total. */
export const archiveCountCopy = (page: ConnectArchivePage): string =>
  `${String(page.agents.length)}${page.nextCursor === null ? "" : "+"} closed ${
    page.agents.length === 1 && page.nextCursor === null ? "agent" : "agents"
  } in the last ${String(connectArchiveWindowDays)} days`

/** Search only the loaded record fields promised by the directory, excluding words and close state. */
export const archiveMatchesQuery = (agent: ArchivedConnectAgent, query: string): boolean => {
  const normalized = query.trim().toLocaleLowerCase("en-US")
  return [agent.name, agent.host, agent.kind, agent.work].some((value) =>
    value.toLocaleLowerCase("en-US").includes(normalized)
  )
}

/** The same local timestamp representation for first seen, closure and last words. */
export const archiveTimestamp = (at: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(at).replace(",", "")

/** Archive rows do not tick or heartbeat; relative age is measured when the loaded view renders. */
export const archiveClosedAge = (closedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - closedAt) / 60_000))
  return minutes < 1
    ? "just now"
    : minutes < 60
    ? `${String(minutes)}m ago`
    : minutes < 1440
    ? `${String(Math.floor(minutes / 60))}h ago`
    : `${String(Math.floor(minutes / 1440))}d ago`
}
