/** Loaded archive pages and their read-only stages. Live terminal/pin/heartbeat state never enters this view. */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Icon, PortalProvider } from "@knpkv/rly/foundations"
import { Button, Sheet, Text } from "@knpkv/rly/primitives"
import { Cause, Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AgentStateLabel } from "./agent-state.js"
import { ConnectArchiveLoadError } from "./archive-client.js"
import {
  appendArchivePage,
  archiveClosedAge,
  archiveCountCopy,
  archiveKindLabel,
  archiveMatchesQuery,
  archivedAgentKey,
  archiveTimestamp
} from "./archive-model.js"
import type { ConnectAtoms } from "./client.js"
import { Creature } from "./creature.js"
import {
  ConnectDirectorySwitch,
  connectArchivedParentHref,
  connectDirectoryHref,
  navigateConnectDirectory,
  syncConnectDirectoryHistory
} from "./directory-view.js"
import {
  connectArchivePageMaxRecords,
  connectArchiveWindowDays,
  type ConnectArchiveCursor,
  type ConnectArchivePage
} from "./model.js"

type ArchiveState =
  | { readonly _tag: "loading"; readonly page: ConnectArchivePage | null }
  | { readonly _tag: "ready"; readonly page: ConnectArchivePage }
  | { readonly _tag: "failed"; readonly page: ConnectArchivePage | null; readonly error: ConnectArchiveLoadError }

/** Archive selection has no live-stage callback; parent links are drawn only for already loaded identities. */
export const ConnectArchiveSurface = ({
  atoms,
  embedded,
  locationSearch,
  roomFooter
}: {
  readonly atoms: ConnectAtoms
  readonly embedded: boolean
  readonly locationSearch: string
  readonly roomFooter?: ReactNode
}) => {
  const [state, setState] = useState<ArchiveState>({ _tag: "loading", page: null })
  const [attempt, setAttempt] = useState<{ readonly cursor: ConnectArchiveCursor | null; readonly revision: number }>({
    cursor: null,
    revision: 0
  })
  const [query, setQuery] = useState("")
  const [selection, setSelection] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const active = useAtomValue(atoms.agents)
  const runPage = useAtomSet(atoms.archivePage, { mode: "promiseExit" })
  const activeSnapshot = AsyncResult.value(active)
  const activeAgents = Option.isSome(activeSnapshot) ? activeSnapshot.value.agents : []
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      const field = search.current
      // Embedders may retain an inactive surface; its shortcut must leave the shell's event uncancelled.
      if (field === null || field.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        field.focus()
      }
    }
    document.addEventListener("keydown", focusSearch)
    return () => document.removeEventListener("keydown", focusSearch)
  }, [])
  useEffect(() => setSelection(new URLSearchParams(locationSearch).get("closed")), [locationSearch])
  useEffect(() => {
    let mounted = true
    void runPage(attempt.cursor).then((exit) => {
      if (!mounted) return
      if (Exit.isSuccess(exit)) {
        setState((previous) => ({ _tag: "ready", page: appendArchivePage(previous.page, exit.value) }))
      } else {
        const failure = Cause.findErrorOption(exit.cause)
        const error = Option.isSome(failure)
          ? failure.value
          : new ConnectArchiveLoadError({ reason: "network", cause: exit.cause })
        setState((previous) => ({ _tag: "failed", page: previous.page, error }))
      }
    })
    return () => {
      mounted = false
    }
  }, [attempt, runPage])
  const request = (cursor: ConnectArchiveCursor | null): void => {
    if (state._tag === "loading") return
    setState({ _tag: "loading", page: state.page })
    setAttempt((previous) => ({ cursor, revision: previous.revision + 1 }))
  }
  const page = state.page
  const agents = page?.agents ?? []
  const filtered = agents.filter((agent) => archiveMatchesQuery(agent, query))
  const selected = agents.find((agent) => archivedAgentKey(agent) === selection) ?? null
  useEffect(() => {
    if (state._tag !== "ready" || selection === null || selected !== null) return
    // Restore only this URL-selected closure. The server bounds each page to 64 and the retained 90-day window.
    if (state.page.nextCursor !== null) {
      setState({ _tag: "loading", page: state.page })
      setAttempt((previous) => ({ cursor: state.page.nextCursor, revision: previous.revision + 1 }))
      return
    }
    // A removed/expired closure has no stage. Replace its stale URL rather than adding a dead history entry.
    setSelection(null)
    const url = new URL(window.location.href)
    url.searchParams.delete("closed")
    syncConnectDirectoryHistory(`${url.pathname}${url.search}${url.hash}`, "replace")
  }, [state, selection, selected])
  const parentId = selected?.relationship?.parentAgentId
  const activeParents =
    parentId === undefined
      ? []
      : activeAgents.filter(
          (agent) => agent.id === parentId && agent.host.toLowerCase() === selected?.host.toLowerCase()
        )
  const activeParent = activeParents.length === 1 ? activeParents[0] : undefined
  const archivedParent =
    activeParent !== undefined || parentId === undefined
      ? undefined
      : agents.find((agent) => agent.agentId === parentId && agent.host.toLowerCase() === selected?.host.toLowerCase())
  const archivedParentHref =
    archivedParent === undefined
      ? null
      : connectArchivedParentHref(
          new URL(connectDirectoryHref("archived"), window.location.href),
          archivedAgentKey(archivedParent)
        )
  const closeStage = (): void => {
    setSelection(null)
    const url = new URL(window.location.href)
    if (!url.searchParams.has("closed")) return
    url.searchParams.delete("closed")
    syncConnectDirectoryHistory(`${url.pathname}${url.search}${url.hash}`)
  }
  const now = Date.now()
  const failed =
    state._tag === "failed" ? (
      <div className={page === null ? "connect-archive-error" : "connect-archive-page-error"} role="alert">
        {page === null ? <Icon decorative name="alert" size="default" /> : null}
        <div>
          {page === null ? <h2>Couldn't load archived agents</h2> : <p>Couldn't load older archived agents.</p>}
          {page === null ? <p>The hub didn't return the archive. Active agents aren't affected.</p> : null}
          <Button
            className="connect-archive-control"
            onClick={() => request(page?.nextCursor ?? null)}
            size="compact"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      </div>
    ) : null
  return (
    <div
      className={
        embedded ? "connect-shell connect-shell-embedded connect-archive-shell" : "connect-shell connect-archive-shell"
      }
    >
      <div className="connect-workspace" data-mode="directory">
        <div className="connect-directory-screen">
          <div className="connect-directory-heading">
            <header
              className={
                embedded ? "connect-embedded-intro connect-directory-title" : "connect-header connect-directory-title"
              }
            >
              <Text as="h1" variant="card-title">
                Connect
              </Text>
              <small className="connect-archive-subtitle">
                {page === null
                  ? state._tag === "loading"
                    ? "Loading the archive..."
                    : "Not loaded"
                  : "Archived, newest closed first"}
              </small>
            </header>
            <ConnectDirectorySwitch archived />
          </div>
          <section aria-label="Archived agents" className="connect-agents connect-archive-directory">
            {page === null ? (
              state._tag === "loading" ? (
                <>
                  <small className="connect-archive-loading" role="status">
                    Loading archived agents...
                  </small>
                  <div aria-hidden="true" className="connect-archive-skeletons">
                    {[0, 1, 2, 3].map((index) => (
                      <div className="connect-archive-skeleton" key={index} />
                    ))}
                  </div>
                </>
              ) : (
                failed
              )
            ) : agents.length === 0 ? (
              <div className="connect-archive-empty">
                No closed agents in the last {String(connectArchiveWindowDays)} days
              </div>
            ) : (
              <>
                <label className="connect-search connect-archive-search">
                  <span>Find archived agent</span>
                  <Icon decorative name="search" size="small" />
                  <input
                    autoComplete="off"
                    id="connect-agent-search"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Name, host, kind..."
                    ref={search}
                    type="search"
                    value={query}
                  />
                  <kbd aria-hidden="true" className="connect-search-shortcut">
                    Ctrl K
                  </kbd>
                </label>
                {page.nextCursor === null ? null : (
                  <small className="connect-archive-scope">Search covers loaded archived agents only.</small>
                )}
                {filtered.length === 0 ? (
                  <div className="connect-archive-empty connect-archive-no-match">
                    <p>
                      {page.nextCursor === null ? "No closed agents" : "No loaded closed agents"} match "{query.trim()}"
                      in Archived.
                    </p>
                    <Button
                      className="connect-archive-control"
                      onClick={() => {
                        setQuery("")
                        search.current?.focus()
                      }}
                      size="compact"
                      variant="secondary"
                    >
                      Clear search
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="connect-family-count">{archiveCountCopy(page)}</p>
                    <div className="connect-archive-list">
                      {filtered.map((agent) => (
                        <button
                          className="connect-archive-agent"
                          key={archivedAgentKey(agent)}
                          onClick={() => setSelection(archivedAgentKey(agent))}
                          type="button"
                        >
                          <Creature
                            closed
                            host={agent.host}
                            id={String(agent.agentId)}
                            size="row"
                            state={agent.state}
                          />
                          <span className="connect-archive-row-copy">
                            <strong>{agent.name}</strong>
                            <small className="connect-archive-metadata">
                              {agent.host}, {archiveKindLabel(agent.kind)}, closed{" "}
                              {archiveClosedAge(agent.closedAt, now)}
                            </small>
                            {agent.lastWords === undefined ? null : (
                              <span className="connect-archive-last-words">{agent.lastWords.text}</span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {failed}
                {page.nextCursor === null || state._tag === "failed" ? null : (
                  <div className="connect-archive-paging">
                    <Button
                      className="connect-archive-more connect-archive-control"
                      disabled={state._tag === "loading"}
                      onClick={() => request(page.nextCursor)}
                      size="compact"
                      variant="secondary"
                    >
                      Show older
                    </Button>
                    <small>Loads the next {String(connectArchivePageMaxRecords)}.</small>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      <PortalProvider>
        <Sheet.Root
          onOpenChange={(open) => {
            if (!open) closeStage()
          }}
          open={selected !== null}
        >
          {selected === null ? null : (
            <Sheet.Content
              className="connect-stage-sheet connect-archive-stage"
              closeLabel="Close"
              description={`${archiveKindLabel(selected.kind)} on ${selected.host}, archived, read-only`}
              title={selected.name}
            >
              <Sheet.Body className="connect-stage connect-archive-stage-body">
                <div className="connect-stage-hero connect-archive-hero">
                  <Creature
                    closed
                    host={selected.host}
                    id={String(selected.agentId)}
                    size="stage"
                    state={selected.state}
                  />
                </div>
                <p className="connect-archive-dates">
                  First seen {archiveTimestamp(selected.firstSeenAt)} → Closed {archiveTimestamp(selected.closedAt)}
                </p>
                <dl className="connect-archive-details">
                  <dt>State at close</dt>
                  <dd>
                    <AgentStateLabel state={selected.state} />
                  </dd>
                  <dt>Kind</dt>
                  <dd>{selected.kind}</dd>
                  <dt>Host</dt>
                  <dd>{selected.host}</dd>
                  <dt>Work</dt>
                  <dd>{selected.work}</dd>
                  {parentId === undefined ? null : (
                    <>
                      <dt>Parent</dt>
                      <dd>
                        {activeParent !== undefined ? (
                          <a href={connectDirectoryHref("active", activeParent)} onClick={navigateConnectDirectory}>
                            {activeParent.name} <Icon decorative name="arrow-right" size="small" />
                          </a>
                        ) : archivedParent !== undefined && archivedParentHref !== null ? (
                          <a href={archivedParentHref} onClick={navigateConnectDirectory}>
                            {archivedParent.name} <Icon decorative name="arrow-right" size="small" />
                          </a>
                        ) : (
                          parentId
                        )}
                      </dd>
                    </>
                  )}
                </dl>
                {selected.lastWords === undefined ? null : (
                  <section className="connect-archive-words">
                    <h2>Last words</h2>
                    <p tabIndex={0}>{selected.lastWords.text}</p>
                    <small>Said {archiveTimestamp(selected.lastWords.createdAt)}</small>
                  </section>
                )}
              </Sheet.Body>
            </Sheet.Content>
          )}
        </Sheet.Root>
      </PortalProvider>
      {embedded ? null : (
        <nav aria-label="Fleet applications" className="fleet-app-nav">
          <a href="/">Approvals</a>
          <a aria-current="page" href="/connect/">
            Connect
          </a>
        </nav>
      )}
      {roomFooter}
    </div>
  )
}
