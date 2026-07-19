import { ServiceMark } from "@knpkv/rly/patterns"
import { Dialog, StateLabel } from "@knpkv/rly/primitives"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { Link, useLocation, useNavigate } from "react-router"

import type { ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { contextualAgentPath } from "../contextualAgentPath.js"
import type { WorkspaceItemPresentation } from "../items/presentWorkspaceItems.js"
import { entityOriginFromLocation, makeWorkspaceEntityRouteState } from "../items/workspaceEntityRoutes.js"
import {
  browserWorkspaceItemsTransport,
  useWorkspaceItems,
  type WorkspaceItemsQuery,
  type WorkspaceItemsTransport
} from "../items/useWorkspaceItems.js"
import { makeReleaseRouteState, releaseOriginFromLocation } from "../releases/releaseRoutes.js"
import { commandSearchItemsHref } from "./commandSearchRoutes.js"
import {
  browserCommandReleasesTransport,
  type CommandReleasePresentation,
  type CommandReleasesTransport,
  useCommandReleases
} from "./useCommandReleases.js"
import styles from "./CommandSearch.module.css"

const MINIMUM_QUERY_LENGTH = 2
const RESULT_LIMIT = 6
const EMPTY_RELEASE_SCOPE: ReadonlySet<ReleaseId> = new Set()

type CommandSearchResult =
  | { readonly _tag: "item"; readonly item: WorkspaceItemPresentation; readonly rank: number }
  | { readonly _tag: "release"; readonly rank: number; readonly release: CommandReleasePresentation }

const kindLabel = (kind: WorkspaceItemPresentation["kind"]): string =>
  kind
    .split("-")
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ")

const isEditingTarget = (target: EventTarget | null): boolean => {
  if (target === null) return false
  if ("isContentEditable" in target && target.isContentEditable === true) return true
  if (!("nodeName" in target) || typeof target.nodeName !== "string") return false
  return target.nodeName === "INPUT" || target.nodeName === "SELECT" || target.nodeName === "TEXTAREA"
}

const matchRank = (query: string, values: ReadonlyArray<string>): number => {
  const normalizedValues = values.map((value) => value.toLocaleLowerCase("en-US"))
  if (normalizedValues.some((value) => value === query)) return 0
  if (normalizedValues.some((value) => value.startsWith(query))) return 1
  return normalizedValues.some((value) => value.includes(query)) ? 2 : 3
}

/** Combine bounded release and service-entity results with deterministic exact/prefix/contains ranking. */
export const commandSearchResults = (
  releases: ReadonlyArray<CommandReleasePresentation>,
  items: ReadonlyArray<WorkspaceItemPresentation>,
  query: string
): ReadonlyArray<CommandSearchResult> => {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US")
  if (normalizedQuery.length === 0) return []
  const releaseResults: ReadonlyArray<CommandSearchResult> = releases.flatMap((release) => {
    const rank = matchRank(normalizedQuery, [release.codename, release.version, release.serviceName, release.status])
    return rank === 3 ? [] : [{ _tag: "release", rank, release }]
  })
  const itemResults: ReadonlyArray<CommandSearchResult> = items.flatMap((item) => {
    const rank = matchRank(normalizedQuery, [item.key, item.title, item.status])
    return rank === 3 ? [] : [{ _tag: "item", item, rank }]
  })
  return [...releaseResults, ...itemResults]
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank
      if (left._tag !== right._tag) return left._tag === "release" ? -1 : 1
      const leftLabel = left._tag === "release" ? left.release.codename : left.item.key
      const rightLabel = right._tag === "release" ? right.release.codename : right.item.key
      return leftLabel.localeCompare(rightLabel)
    })
    .slice(0, RESULT_LIMIT)
}

export type CommandSearchProps = {
  readonly releaseTransport?: CommandReleasesTransport
  readonly transport?: WorkspaceItemsTransport
  readonly workspaceId: WorkspaceId
}

type CommandSearchSurfaceProps = CommandSearchProps & { readonly sessionKey: string }

const CommandSearchSurface = ({
  releaseTransport = browserCommandReleasesTransport,
  sessionKey,
  transport = browserWorkspaceItemsTransport,
  workspaceId
}: CommandSearchSurfaceProps): ReactElement => {
  const browserSession = useBrowserSession()
  const location = useLocation()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const normalizedQuery = query.trim()
  const deferredQuery = useDeferredValue(normalizedQuery)
  const queryReady = deferredQuery.length >= MINIMUM_QUERY_LENGTH
  const releases = useCommandReleases(open ? sessionKey : null, browserSession.invalidateSession, releaseTransport)
  const releaseState = releases.state
  const releaseScope = useMemo(
    () =>
      releaseState._tag === "ready" && releaseState.workspaceId === workspaceId
        ? new Set(releaseState.releases.map(({ id }) => id))
        : EMPTY_RELEASE_SCOPE,
    [releaseState, workspaceId]
  )
  const releasesReady = releaseState._tag === "ready" && releaseState.workspaceId === workspaceId
  const filters = useMemo<WorkspaceItemsQuery>(
    () => ({ owner: "all", query: queryReady ? deferredQuery : "", service: "all", status: "all", type: "all" }),
    [deferredQuery, queryReady]
  )
  const items = useWorkspaceItems(
    workspaceId,
    releaseScope,
    filters,
    releaseState._tag === "ready" ? releaseState.releases.map(({ id }) => id).join(":") : "command-search",
    open && queryReady && releasesReady ? sessionKey : null,
    browserSession.invalidateSession,
    transport
  )
  const itemsReady = items.state._tag === "ready" && !items.state.refreshing
  const results =
    releasesReady && itemsReady ? commandSearchResults(releaseState.releases, items.state.items, deferredQuery) : []
  const showListbox = results.length > 0

  const changeOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery("")
      setHighlightedIndex(0)
    }
  }

  useEffect(() => {
    const openFromKeyboard = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        isEditingTarget(event.target) ||
        event.key.toLocaleLowerCase("en-US") !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    document.addEventListener("keydown", openFromKeyboard)
    return () => document.removeEventListener("keydown", openFromKeyboard)
  }, [])

  useEffect(() => setHighlightedIndex(0), [deferredQuery])

  const openResult = (result: CommandSearchResult): void => {
    changeOpen(false)
    if (result._tag === "release") {
      navigate(result.release.href, {
        state: makeReleaseRouteState(workspaceId, result.release.id, releaseOriginFromLocation(location))
      })
      return
    }
    const item = result.item
    navigate(item.href, {
      state: makeWorkspaceEntityRouteState(
        location.state,
        workspaceId,
        item.entityId,
        entityOriginFromLocation(location)
      )
    })
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (results.length === 0) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      setHighlightedIndex((current) => (current + delta + results.length) % results.length)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const selected = results[highlightedIndex]
      if (selected !== undefined) openResult(selected)
    }
  }

  const content = (): ReactElement => {
    if (normalizedQuery.length < MINIMUM_QUERY_LENGTH) {
      return (
        <div className={styles.message}>
          <strong>Type two characters.</strong>
          <span>Search releases, tickets, pull requests, docs, pipelines, deployments, and time.</span>
        </div>
      )
    }
    const loading =
      deferredQuery !== normalizedQuery ||
      releaseState._tag === "idle" ||
      releaseState._tag === "loading" ||
      items.state._tag === "idle" ||
      items.state._tag === "loading"
    if (loading) return <div className={styles.loading}>Searching the current workspace…</div>
    if (!releasesReady || items.state._tag === "failed") {
      return (
        <div className={styles.message}>
          <strong>Search is unavailable.</strong>
          <span>The release and item indexes were not changed.</span>
          <button
            onClick={() => {
              releases.retry()
              items.retry()
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      )
    }
    if (results.length === 0) {
      return (
        <div className={styles.message}>
          <strong>No release or current item matches “{deferredQuery}”.</strong>
          <span>Try a release name, version, key, title, or current status.</span>
        </div>
      )
    }
    return (
      <div aria-label="Workspace search results" className={styles.results} id="command-search-results" role="listbox">
        {results.map((result, index) => {
          const isRelease = result._tag === "release"
          const key = isRelease ? result.release.id : result.item.entityId
          return (
            <button
              aria-selected={index === highlightedIndex}
              className={styles.result}
              id={`command-search-option-${index}`}
              key={key}
              onClick={() => openResult(result)}
              onMouseEnter={() => setHighlightedIndex(index)}
              role="option"
              type="button"
            >
              {isRelease ? (
                <span className={styles.releaseMark}>R</span>
              ) : (
                <ServiceMark service={result.item.service} size="compact" />
              )}
              <span className={styles.resultCopy}>
                <span className={styles.resultKey}>
                  {isRelease ? `${result.release.version} · Release` : result.item.key}
                </span>
                <strong>{isRelease ? result.release.codename : result.item.title}</strong>
                <span>{isRelease ? result.release.serviceName : kindLabel(result.item.kind)}</span>
              </span>
              <StateLabel
                label={isRelease ? result.release.status : result.item.status}
                size="compact"
                tone={isRelease ? result.release.tone : result.item.tone}
              />
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <Dialog.Root onOpenChange={changeOpen} open={open}>
      <Dialog.Trigger className={styles.trigger} size="compact" variant="quiet">
        Search ⌘K
      </Dialog.Trigger>
      <Dialog.Content
        className={styles.dialog}
        description="Find releases and current work, or continue with Relay."
        initialFocusRef={inputRef}
        size="wide"
        title="Go anywhere."
      >
        <label className={styles.searchField}>
          <span className={styles.visuallyHidden}>Search workspace</span>
          <input
            aria-activedescendant={showListbox ? `command-search-option-${highlightedIndex}` : undefined}
            aria-autocomplete="list"
            aria-busy={
              deferredQuery !== normalizedQuery || releaseState._tag === "loading" || items.state._tag === "loading"
            }
            aria-controls={showListbox ? "command-search-results" : undefined}
            aria-expanded={showListbox}
            aria-label="Search workspace"
            autoComplete="off"
            maxLength={200}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Release, ticket, PR, page, pipeline…"
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
        </label>
        {content()}
        <footer className={styles.footer}>
          <Link onClick={() => changeOpen(false)} to={commandSearchItemsHref(workspaceId, normalizedQuery)}>
            Open item results
          </Link>
          <Link
            onClick={() => changeOpen(false)}
            to={contextualAgentPath(location.pathname, location.search, location.hash)}
          >
            Ask Relay from here
          </Link>
          <span>↑↓ choose · Enter open · Esc close</span>
        </footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}

/** Suppress search when a syntactically valid route does not belong to the readable browser session. */
export const CommandSearch = (props: CommandSearchProps): ReactElement | null => {
  const browserSession = useBrowserSession()
  const readableSession =
    browserSession.state._tag === "authenticated"
      ? browserSession.state.session
      : browserSession.state._tag === "storage-unavailable"
        ? browserSession.state.session
        : null
  const sessionKey = browserReadableSessionKey(browserSession.state)
  if (readableSession !== null && readableSession.workspaceId !== props.workspaceId) return null
  if (sessionKey === null) {
    return (
      <Link className={styles.pairTrigger} to="/pair">
        Pair to search
      </Link>
    )
  }
  return <CommandSearchSurface {...props} sessionKey={sessionKey} />
}
