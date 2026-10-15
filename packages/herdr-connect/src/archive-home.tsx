import { Button, StateLabel } from "@knpkv/rly/primitives"
import { useLayoutEffect, useRef } from "react"
import { archiveCountCopy, archivedAgentKey } from "./archive-model.js"
import { Creature } from "./creature.js"
import type { ConnectArchiveCursor, ConnectArchivePage } from "./model.js"
import { connectRelationLabel } from "./view.js"

const closedTime = (at: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(at)

/** Home's archive presentation shares the existing paging controller; it adds no reads or actions. */
export const ConnectHomeArchive = ({
  failed,
  loading,
  open,
  page,
  request
}: {
  readonly page: ConnectArchivePage | null
  readonly loading: boolean
  readonly failed: boolean
  readonly request: (cursor: ConnectArchiveCursor | null) => void
  readonly open: (key: string) => void
}) => {
  const region = useRef<HTMLElement>(null)
  const pendingFocus = useRef<number | null>(null)
  const requestPage = (cursor: ConnectArchiveCursor | null): void => {
    if (region.current?.contains(document.activeElement) === true) pendingFocus.current = page?.agents.length ?? 0
    request(cursor)
  }
  // Loading replaces the controls with status text. Retain a focus anchor, then move to the new result.
  useLayoutEffect(() => {
    const count = pendingFocus.current
    const owner = region.current
    if (count === null || owner === null) return
    if (document.activeElement !== document.body && !owner.contains(document.activeElement)) {
      pendingFocus.current = null
      return
    }
    if (loading) {
      owner.focus({ preventScroll: true })
      return
    }
    const rows = owner.querySelectorAll<HTMLButtonElement>("button.connect-home-archive-row")
    const target = failed
      ? owner.querySelector<HTMLButtonElement>(
          ".connect-home-archive-error button, .connect-home-archive-page-error button"
        )
      : (rows[count] ?? rows[0])
    const focusTarget = target ?? owner
    focusTarget.focus({ preventScroll: true })
    pendingFocus.current = null
  }, [loading, failed, page])
  const failure = failed ? (
    <div className={page === null ? "connect-home-archive-error" : "connect-home-archive-page-error"} role="alert">
      {page === null ? (
        <div>
          <StateLabel icon="alert" label="Couldn’t load archived agents" tone="caution" size="compact" />
          <p>Try again in a moment.</p>
        </div>
      ) : (
        <p>
          <StateLabel icon="alert" label="Couldn’t load older agents." tone="caution" size="compact" />
        </p>
      )}
      <Button
        className="connect-home-archive-control"
        onClick={() => requestPage(page?.nextCursor ?? null)}
        size={page === null ? "default" : "compact"}
        variant="secondary"
      >
        Try again
      </Button>
    </div>
  ) : null
  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label="Archived agents"
      aria-busy={loading}
      className="connect-home-archive"
    >
      {page === null ? (
        loading ? (
          <>
            <span className="connect-home-archive-loading" role="status">
              Loading archived agents
            </span>
            <div className="connect-home-archive-list" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <div className="connect-home-archive-row connect-home-archive-skeleton" key={index}>
                  <span className="connect-home-archive-skeleton-creature" />
                  <span className="connect-home-archive-copy">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          failure
        )
      ) : page.agents.length === 0 ? (
        <div className="connect-home-archive-empty">No closed agents in the last 90 days</div>
      ) : (
        <>
          <p className="connect-home-archive-count">{archiveCountCopy(page)}</p>
          <div className="connect-home-archive-list">
            {page.agents.map((agent) => (
              <button
                className="connect-home-archive-row"
                key={archivedAgentKey(agent)}
                onClick={() => open(archivedAgentKey(agent))}
                type="button"
              >
                <Creature
                  closed
                  host={agent.host}
                  hueFamily={agent.hue}
                  id={String(agent.agentId)}
                  name={agent.name}
                  size="row"
                  state={agent.state}
                  statePolicy="home"
                />
                <span className="connect-home-archive-copy">
                  <span className="connect-home-archive-top">
                    <strong>{agent.name}</strong>
                    <small>Closed {closedTime(agent.closedAt)}</small>
                  </span>
                  <small>
                    {agent.relationship === undefined
                      ? "Primary"
                      : `${connectRelationLabel(agent.relationship.relation)}${agent.relationship.parentName === undefined ? "" : ` with ${agent.relationship.parentName}`}`}
                    , {agent.host}
                  </small>
                  {agent.lastWords === undefined ? null : (
                    <span className="connect-home-archive-words">{agent.lastWords.text}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {failure}
          {failed || page.nextCursor === null ? null : loading ? (
            <div className="connect-home-archive-paging" role="status">
              <span className="connect-home-archive-spinner" aria-hidden="true" />
              Loading older agents…
            </div>
          ) : (
            <div className="connect-home-archive-paging">
              <Button
                className="connect-home-archive-control"
                onClick={() => requestPage(page.nextCursor)}
                size="compact"
                variant="secondary"
              >
                Show older
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
