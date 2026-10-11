import { AgentStateLabel, Creature } from "@knpkv/herdr-connect/surface"
import type { ReactElement } from "react"
import { activityItemsFor, statusLabel } from "./activity-history.js"
import type { DashboardSnapshot } from "./dashboard-model.js"
import { fleetModule, moduleHref } from "./modules.js"

/** The existing dashboard owner supplies this snapshot; Today starts no dashboard/history reader. */
export const TodayFleetAgents = ({ snapshot }: { readonly snapshot: DashboardSnapshot }): ReactElement => {
  const agents = snapshot.status.herdr.agents.slice(0, 3)
  return (
    <section className="today-rail-section">
      <div className="today-section-heading">
        <h2>Bots on the move</h2>
        <span>On {snapshot.host}</span>
      </div>
      {!snapshot.status.herdr.available ? (
        <p>Agent status is unavailable on {snapshot.host}.</p>
      ) : agents.length === 0 ? (
        <p>No agents running on {snapshot.host}.</p>
      ) : (
        <ul className="today-agent-list">
          {agents.map((agent) => {
            const copy = (
              <>
                <Creature host={snapshot.host} id={agent.agentId ?? agent.paneId} size="row" state={agent.status} />
                <span>
                  <strong>{agent.name}</strong>
                  <span>{agent.work}</span>
                  <AgentStateLabel state={agent.status} />
                </span>
              </>
            )
            return (
              <li key={agent.paneId}>
                {agent.agentId === null ? (
                  <div className="today-agent">{copy}</div>
                ) : (
                  <a
                    className="today-agent"
                    href={moduleHref(
                      fleetModule,
                      "connect",
                      new URLSearchParams({ host: snapshot.host, agent: agent.agentId, open: "stage" })
                    )}
                  >
                    {copy}
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <a className="today-link" href={moduleHref(fleetModule, "connect")}>
        All bots <span aria-hidden="true">›</span>
      </a>
    </section>
  )
}

/** Recent activity comes from the same sanitized history already displayed by Fleet. */
export const TodayFleetHistory = ({ snapshot }: { readonly snapshot: DashboardSnapshot }): ReactElement => {
  const records = activityItemsFor(
    snapshot.records.filter(
      (record) => record.status !== "pending_approval" && record.status !== "queued" && record.status !== "running"
    )
  ).slice(0, 3)
  return (
    <section className="today-rail-section">
      <h2>Already happened</h2>
      {records.length === 0 ? (
        <p>No recent activity on {snapshot.host}.</p>
      ) : (
        <ul className="today-history-list">
          {records.map((record) => (
            <li key={record.id}>
              <time dateTime={new Date(record.timestamp).toISOString()}>{record.time}</time>
              <span>
                {record.title}
                <small>{statusLabel(record.status)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      <a className="today-link" href={moduleHref(fleetModule, "work")}>
        Fleet activity <span aria-hidden="true">›</span>
      </a>
    </section>
  )
}
