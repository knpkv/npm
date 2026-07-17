import { ServiceMark, type RlyService } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useMemo } from "react"
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router"

import type { DeliveryEntityKind } from "../../domain/deliveryGraph.js"
import { useBrowserSession } from "../BrowserSession.js"
import { PortfolioOverviewView, type PortfolioOverviewState } from "../portfolio/PortfolioOverview.js"
import type { WorkspaceReleaseOutletContext } from "../releases/WorkspaceReleaseLayout.js"
import { makeReleaseRouteState, releaseOriginFromLocation } from "../releases/releaseRoutes.js"
import { releaseWorksetSessionKey } from "../releases/ReleaseWorkset.js"
import type { WorkspaceItemPresentation, WorkspaceItemStatus } from "./presentWorkspaceItems.js"
import { useWorkspaceItems } from "./useWorkspaceItems.js"
import styles from "./ItemsPage.module.css"

interface ItemFilters {
  readonly query: string
  readonly service: string
  readonly status: WorkspaceItemStatus | "all"
  readonly type: DeliveryEntityKind | "all"
}

const entityKinds: ReadonlyArray<DeliveryEntityKind> = [
  "issue",
  "pull-request",
  "page",
  "pipeline-execution",
  "deployment",
  "time-entry"
]
const services: ReadonlyArray<RlyService> = ["jira", "codecommit", "confluence", "codepipeline", "clockify"]
const freshnessFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

export const formatItemFreshness = (freshness: string): string => freshnessFormatter.format(Date.parse(freshness))

export const itemsLocationWithSearch = (
  location: Pick<Location, "hash" | "pathname">,
  params: URLSearchParams
): { readonly hash: string; readonly pathname: string; readonly search: string } => ({
  hash: location.hash,
  pathname: location.pathname,
  search: params.size === 0 ? "" : `?${params.toString()}`
})

export const unlinkedItemLocation = (
  pathname: string,
  params: URLSearchParams,
  entityId: string
): { readonly hash: string; readonly pathname: string; readonly search: string } => {
  const next = new URLSearchParams(params)
  next.set("object", entityId)
  return {
    hash: "#item-details",
    pathname,
    search: `?${next.toString()}`
  }
}

const entityKind = (value: string | null): DeliveryEntityKind | "all" =>
  entityKinds.find((candidate) => candidate === value) ?? "all"

const itemStatus = (value: string | null): WorkspaceItemStatus | "all" =>
  value === "active" || value === "done" || value === "failed" ? value : "all"

const filtersFrom = (params: URLSearchParams): ItemFilters => ({
  query: params.get("q")?.trim() ?? "",
  service: services.find((candidate) => candidate === params.get("service")) ?? "all",
  status: itemStatus(params.get("status")),
  type: entityKind(params.get("type"))
})

export const filterWorkspaceItems = (
  items: ReadonlyArray<WorkspaceItemPresentation>,
  filters: ItemFilters
): ReadonlyArray<WorkspaceItemPresentation> => {
  const query = filters.query.toLocaleLowerCase("en-US")
  return items.filter(
    (item) =>
      (query.length === 0 || `${item.key} ${item.title} ${item.status}`.toLocaleLowerCase("en-US").includes(query)) &&
      (filters.service === "all" || item.service === filters.service) &&
      (filters.status === "all" || item.statusGroup === filters.status) &&
      (filters.type === "all" || item.kind === filters.type)
  )
}

export const selectWorkspaceItem = (
  items: ReadonlyArray<WorkspaceItemPresentation>,
  entityId: string | null
): WorkspaceItemPresentation | null =>
  entityId === null ? null : (items.find((item) => item.entityId === entityId) ?? null)

const labelForKind = (kind: DeliveryEntityKind): string =>
  kind
    .split("-")
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ")

/** Compact workspace-wide index of normalized delivery objects. */
export const ItemsPage = (): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const browserSession = useBrowserSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const portfolio = context.controller.state._tag === "ready" ? context.controller.state.portfolio : null
  const routableReleaseIds = useMemo(() => new Set(portfolio?.releases.map(({ id }) => id) ?? []), [portfolio])
  const refreshKey =
    context.controller.state._tag === "ready" ? context.controller.state.portfolio.generatedAt : "pending"
  const sessionKey = releaseWorksetSessionKey(browserSession.state)
  const controller = useWorkspaceItems(
    context.workspaceId,
    routableReleaseIds,
    refreshKey,
    sessionKey,
    browserSession.invalidateSession
  )
  const filters = filtersFrom(searchParams)
  const replaceSearch = (next: URLSearchParams): void => {
    navigate(itemsLocationWithSearch(location, next), { replace: true })
  }
  const update = (key: keyof ItemFilters, value: string): void => {
    const next = new URLSearchParams(searchParams)
    if (value.length === 0 || value === "all") next.delete(key === "query" ? "q" : key)
    else next.set(key === "query" ? "q" : key, value)
    replaceSearch(next)
  }

  const portfolioBoundary: PortfolioOverviewState | null =
    context.controller.state._tag !== "ready"
      ? context.controller.state
      : sessionKey === null
        ? {
            _tag: "session",
            reason: browserSession.state._tag === "authenticated" ? "checking" : browserSession.state._tag
          }
        : null
  if (portfolioBoundary?._tag === "loading") {
    return (
      <section aria-label="Loading delivery items" className={styles.page}>
        <Skeleton height="8rem" variant="block" />
        <Skeleton height="20rem" variant="block" />
      </section>
    )
  }
  if (portfolioBoundary !== null) {
    return (
      <PortfolioOverviewView
        onPreviewRelease={() => undefined}
        onRetry={context.controller.onRetry}
        state={portfolioBoundary}
      />
    )
  }
  if (controller.state._tag === "idle" || controller.state._tag === "loading") {
    return (
      <section aria-label="Loading delivery items" className={styles.page}>
        <Skeleton height="8rem" variant="block" />
        <Skeleton height="20rem" variant="block" />
      </section>
    )
  }
  if (controller.state._tag === "failed") {
    return (
      <StatePanel
        action={<Button onClick={controller.retry}>Try again</Button>}
        description="Control Center could not read the normalized delivery index. Saved source facts remain unchanged."
        title="Items unavailable"
        tone="caution"
      />
    )
  }

  const visibleItems = filterWorkspaceItems(controller.state.items, filters)
  const selectedEntityId = searchParams.get("object")
  const selectedItem = selectWorkspaceItem(controller.state.items, selectedEntityId)
  const clearSelection = (): void => {
    const next = new URLSearchParams(searchParams)
    next.delete("object")
    navigate(
      {
        hash: "#results",
        pathname: location.pathname,
        search: next.size === 0 ? "" : `?${next.toString()}`
      },
      { replace: true }
    )
  }
  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <Text as="p" tone="secondary" variant="label">
          Workspace items
        </Text>
        <Text as="h1" variant="verdict">
          Find release work.
        </Text>
        <Text tone="secondary" variant="body-large">
          One quiet index across tickets, pull requests, docs, pipelines, deployments, and time.
        </Text>
      </header>

      <section aria-label="Item filters" className={styles.filters}>
        <label className={styles.search}>
          <span>Search</span>
          <input
            onChange={(event) => update("query", event.currentTarget.value)}
            placeholder="Key, title, or status"
            type="search"
            value={filters.query}
          />
        </label>
        <label>
          <span>Service</span>
          <select onChange={(event) => update("service", event.currentTarget.value)} value={filters.service}>
            <option value="all">All services</option>
            {services.map((service) => (
              <option key={service} value={service}>
                {service}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select onChange={(event) => update("type", event.currentTarget.value)} value={filters.type}>
            <option value="all">All types</option>
            {entityKinds.map((kind) => (
              <option key={kind} value={kind}>
                {labelForKind(kind)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select onChange={(event) => update("status", event.currentTarget.value)} value={filters.status}>
            <option value="all">Any status</option>
            <option value="active">Active</option>
            <option value="done">Done</option>
            <option value="failed">Needs attention</option>
          </select>
        </label>
      </section>

      {selectedEntityId === null ? null : selectedItem === null ? (
        <div id="item-details">
          <StatePanel
            action={<Button onClick={clearSelection}>Back to items</Button>}
            description="This item is not present in the current bounded workspace index. It may have been deleted or fall outside this result prefix."
            title="Item unavailable"
            tone="caution"
          />
        </div>
      ) : (
        <Surface as="section" className={styles.selection} id="item-details" padding="spacious" tone="secondary">
          <div className={styles.selectionHeader}>
            <ServiceMark service={selectedItem.service} size="compact" />
            <StateLabel label={selectedItem.status} size="compact" tone={selectedItem.tone} />
          </div>
          <Text as="p" tone="secondary" variant="label">
            {selectedItem.key} · {labelForKind(selectedItem.kind)}
          </Text>
          <Text as="h2" variant="section-title">
            {selectedItem.title}
          </Text>
          <Text tone="secondary" variant="body-large">
            {selectedItem.releaseId === null
              ? "This current object is not linked to a release yet. Its provider-specific full view will remain available here when that integration is connected."
              : "This object is linked to a release and can be opened in its complete delivery context."}
          </Text>
          <div className={styles.selectionActions}>
            {selectedItem.releaseId === null ? null : (
              <Link
                state={makeReleaseRouteState(
                  context.workspaceId,
                  selectedItem.releaseId,
                  releaseOriginFromLocation(location)
                )}
                to={selectedItem.href}
              >
                Open release context
              </Link>
            )}
            <Button onClick={clearSelection}>Back to items</Button>
          </div>
        </Surface>
      )}

      <div className={styles.resultHeading} id="results">
        <Text as="h2" variant="section-title">
          {visibleItems.length} of {controller.state.items.length} workspace items
        </Text>
        <StateLabel
          label={controller.state.truncated ? "Bounded workspace result" : "Workspace scope"}
          size="compact"
          tone={controller.state.truncated ? "caution" : "neutral"}
        />
      </div>

      {visibleItems.length === 0 ? (
        <StatePanel
          action={<Button onClick={() => replaceSearch(new URLSearchParams())}>Clear filters</Button>}
          description="Try a broader word, service, type, or status. No demo object is substituted."
          title="No matching items"
        />
      ) : (
        <div className={styles.items}>
          {visibleItems.map((item) => (
            <Surface as="article" className={styles.item} key={item.entityId} padding="none" tone="secondary">
              <ServiceMark service={item.service} size="compact" />
              <Link
                className={styles.itemLink}
                state={
                  item.releaseId === null
                    ? undefined
                    : makeReleaseRouteState(context.workspaceId, item.releaseId, releaseOriginFromLocation(location))
                }
                to={
                  item.releaseId === null
                    ? unlinkedItemLocation(location.pathname, searchParams, item.entityId)
                    : item.href
                }
              >
                <span>{item.key}</span>
                <strong>{item.title}</strong>
              </Link>
              <div className={styles.meta}>
                <StateLabel label={item.status} size="compact" tone={item.tone} />
                <span>{labelForKind(item.kind)}</span>
                <span>{item.owner}</span>
                <time dateTime={item.freshness} title={`Synchronized ${item.freshness}`}>
                  {formatItemFreshness(item.freshness)}
                </time>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </article>
  )
}
