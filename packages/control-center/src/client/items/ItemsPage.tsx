import { PeopleStrip, ServiceMark } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type ReactElement, useMemo, useState } from "react"
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router"

import type { DeliveryEntityKind, DeliveryEntityService } from "../../domain/deliveryGraph.js"
import { PersonId } from "../../domain/identifiers.js"
import { useBrowserSession } from "../BrowserSession.js"
import { PortfolioOverviewView, type PortfolioOverviewState } from "../portfolio/PortfolioOverview.js"
import type { WorkspaceReleaseOutletContext } from "../releases/WorkspaceReleaseLayout.js"
import { makeReleaseRouteState, releaseOriginFromLocation } from "../releases/releaseRoutes.js"
import { releaseWorksetSessionKey } from "../releases/ReleaseWorkset.js"
import { rememberWorkspaceScrollPosition } from "../workspaceScrollRestoration.js"
import {
  type WorkspaceItemPresentation,
  type WorkspaceItemStatus,
  workspaceItemReleaseHref
} from "./presentWorkspaceItems.js"
import { browserWorkspaceItemsTransport, useWorkspaceItems, type WorkspaceItemsTransport } from "./useWorkspaceItems.js"
import { AuthorizedSharePanel } from "./AuthorizedSharePanel.js"
import type { AuthorizedShareTransport } from "./authorizedShareTransport.js"
import styles from "./ItemsPage.module.css"
import { entityOriginFromLocation, makeWorkspaceEntityRouteState } from "./workspaceEntityRoutes.js"

interface ItemFilters {
  readonly query: string
  readonly owner: PersonId | "all"
  readonly service: DeliveryEntityService | "all"
  readonly status: WorkspaceItemStatus | "all"
  readonly type: DeliveryEntityKind | "all"
}

export interface ItemsPageProps {
  readonly shareTransport?: AuthorizedShareTransport
  readonly transport?: WorkspaceItemsTransport
}

const entityKinds: ReadonlyArray<DeliveryEntityKind> = [
  "issue",
  "pull-request",
  "page",
  "pipeline-execution",
  "deployment",
  "time-entry"
]
const services: ReadonlyArray<DeliveryEntityService> = ["jira", "codecommit", "confluence", "codepipeline", "clockify"]
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

const itemOwner = (value: string | null): PersonId | "all" => {
  const decoded = Schema.decodeUnknownOption(PersonId)(value)
  return Option.isSome(decoded) ? decoded.value : "all"
}

const filtersFrom = (params: URLSearchParams): ItemFilters => ({
  owner: itemOwner(params.get("owner")),
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
      (filters.owner === "all" || item.owners.some(({ id }) => id === filters.owner)) &&
      (filters.status === "all" || item.statusGroup === filters.status) &&
      (filters.type === "all" || item.kind === filters.type)
  )
}

const ItemOwners = ({ item }: { readonly item: WorkspaceItemPresentation }): ReactElement => {
  const [expanded, setExpanded] = useState(false)
  if (item.owners.length === 0) return <span>Unassigned</span>
  return (
    <span className={styles.ownerGroup}>
      <PeopleStrip
        aria-label={`${item.key} collaborators${item.ownersTruncated ? ", more collaborators not shown" : ""}`}
        className={styles.owners}
        expanded={expanded}
        limit={2}
        onExpandedChange={setExpanded}
        people={item.owners}
        size="compact"
      />
      {item.ownersTruncated ? <span className={styles.ownerLimit}>20+ people · More not shown</span> : null}
    </span>
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

export const workspaceItemMembershipDescription = (item: WorkspaceItemPresentation): string => {
  if (item.releaseIds.length === 0) {
    return "This current object is not linked to a release yet. Its provider-specific full view will remain available here when that integration is connected."
  }
  if (item.routableReleaseIds.length === 0) {
    return `This object is linked to ${item.releaseIds.length}${item.releaseMembershipsTruncated ? "+" : ""} release${item.releaseIds.length === 1 ? "" : "s"} outside the current portfolio. Its membership remains visible without routing to an unavailable release page.`
  }
  if (item.releaseIds.length === 1) {
    return "This object is linked to one release and can be opened in its complete delivery context."
  }
  return `This object is linked to ${item.releaseIds.length}${item.releaseMembershipsTruncated ? "+" : ""} releases. Choose the exact release context to avoid silently substituting another delivery trace.`
}

/** Compact workspace-wide index of normalized delivery objects. */
export const ItemsPage = ({
  shareTransport,
  transport = browserWorkspaceItemsTransport
}: ItemsPageProps = {}): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const browserSession = useBrowserSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const portfolio = context.controller.state._tag === "ready" ? context.controller.state.portfolio : null
  const releaseById = useMemo(
    () => new Map(portfolio?.releases.map((release) => [release.id, release]) ?? []),
    [portfolio]
  )
  const routableReleaseIds = useMemo(() => new Set(portfolio?.releases.map(({ id }) => id) ?? []), [portfolio])
  const refreshKey =
    context.controller.state._tag === "ready" ? context.controller.state.portfolio.generatedAt : "pending"
  const sessionKey = releaseWorksetSessionKey(browserSession.state)
  const filters = filtersFrom(searchParams)
  const controller = useWorkspaceItems(
    context.workspaceId,
    routableReleaseIds,
    filters,
    refreshKey,
    sessionKey,
    browserSession.invalidateSession,
    transport
  )
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

  const visibleItems = controller.state.items
  const hasSelectedOwnerOption =
    filters.owner === "all" || controller.state.ownerOptions.some(({ personId }) => personId === filters.owner)
  const selectedOwner =
    filters.owner === "all"
      ? undefined
      : controller.state.items.flatMap(({ owners }) => owners).find(({ id }) => id === filters.owner)
  const selectedEntityId = searchParams.get("object")
  const selectedItem = selectWorkspaceItem(controller.state.items, selectedEntityId)
  const shareOwnerPersonId =
    browserSession.state._tag === "authenticated" &&
    browserSession.state.session.permission === "workspace-owner" &&
    browserSession.state.session.actor._tag === "human"
      ? browserSession.state.session.actor.personId
      : null
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
            maxLength={200}
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
          <span>Owner</span>
          <select onChange={(event) => update("owner", event.currentTarget.value)} value={filters.owner}>
            <option value="all">Anyone</option>
            {filters.owner !== "all" && !hasSelectedOwnerOption ? (
              <option value={filters.owner}>{selectedOwner?.name ?? `Owner …${filters.owner.slice(-6)}`}</option>
            ) : null}
            {controller.state.ownerOptions.map((owner) => (
              <option key={owner.personId} value={owner.personId}>
                {owner.displayName}
              </option>
            ))}
            {controller.state.ownerOptionsTruncated ? <option disabled>More owners not shown</option> : null}
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
            {workspaceItemMembershipDescription(selectedItem)}
          </Text>
          <ItemOwners item={selectedItem} />
          {shareOwnerPersonId === null ? null : (
            <AuthorizedSharePanel
              key={selectedItem.entityId}
              currentPersonId={shareOwnerPersonId}
              entityId={selectedItem.entityId}
              grantees={controller.state.ownerOptions}
              workspaceId={context.workspaceId}
              {...(shareTransport === undefined ? {} : { transport: shareTransport })}
            />
          )}
          <div className={styles.selectionActions}>
            <div className={styles.membershipChoices}>
              {selectedItem.routableReleaseIds.map((releaseId) => {
                const release = releaseById.get(releaseId)
                return (
                  <Link
                    key={releaseId}
                    state={makeReleaseRouteState(context.workspaceId, releaseId, releaseOriginFromLocation(location))}
                    to={workspaceItemReleaseHref(context.workspaceId, releaseId, selectedItem.entityId)}
                  >
                    Open {release === undefined ? `release ${releaseId.slice(-6)}` : release.relay.codename}
                    {release === undefined ? null : <span>{release.version}</span>}
                  </Link>
                )
              })}
            </div>
            <Button onClick={clearSelection}>Back to items</Button>
          </div>
        </Surface>
      )}

      <div className={styles.resultHeading} id="results">
        <Text as="h2" variant="section-title">
          {controller.state.matchedCount} of {controller.state.totalCount} workspace items
        </Text>
        <StateLabel
          label={
            controller.state.refreshing
              ? "Updating results"
              : controller.state.truncated
                ? "Bounded workspace result"
                : "Workspace scope"
          }
          size="compact"
          tone={controller.state.truncated && !controller.state.refreshing ? "caution" : "neutral"}
        />
      </div>

      {visibleItems.length === 0 ? (
        <StatePanel
          action={<Button onClick={() => replaceSearch(new URLSearchParams())}>Clear filters</Button>}
          description="Try a broader word, owner, service, type, or status. No demo object is substituted."
          title="No matching items"
        />
      ) : (
        <div className={styles.items}>
          {visibleItems.map((item) => (
            <Surface as="article" className={styles.item} key={item.entityId} padding="none" tone="secondary">
              <ServiceMark service={item.service} size="compact" />
              <Link
                className={styles.itemLink}
                onClick={() => rememberWorkspaceScrollPosition(location)}
                state={makeWorkspaceEntityRouteState(
                  location.state,
                  context.workspaceId,
                  item.entityId,
                  entityOriginFromLocation(location)
                )}
                to={item.href}
              >
                <span>{item.key}</span>
                <strong>{item.title}</strong>
              </Link>
              <div className={styles.meta}>
                <StateLabel label={item.status} size="compact" tone={item.tone} />
                <span>{labelForKind(item.kind)}</span>
                <span>
                  {item.releaseIds.length === 0
                    ? "Unlinked"
                    : `${item.releaseIds.length}${item.releaseMembershipsTruncated ? "+" : ""} release${item.releaseIds.length === 1 ? "" : "s"}`}
                </span>
                <ItemOwners item={item} />
                <time dateTime={item.freshness} title={`Synchronized ${item.freshness}`}>
                  {formatItemFreshness(item.freshness)}
                </time>
              </div>
              {shareOwnerPersonId === null ? null : (
                <Link
                  className={styles.shareLink}
                  to={unlinkedItemLocation(location.pathname, searchParams, item.entityId)}
                >
                  Share
                </Link>
              )}
            </Surface>
          ))}
        </div>
      )}
    </article>
  )
}
