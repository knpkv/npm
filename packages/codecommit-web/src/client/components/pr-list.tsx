/**
 * Pull-request decision queue.
 *
 * Owns the complete home-page composition while preserving the URL-backed
 * filter contract: summary facets, text and structured filters, review mode,
 * date bounds, grouping, loading, empty, and SSO-recovery states all operate
 * on the same pull-request collection.
 *
 * @module
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { needsMyReview } from "@knpkv/codecommit-core/Domain.js"
import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { LogInIcon } from "lucide-react"
import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router"
import { appStateAtom, notificationsSsoLoginAtom } from "../atoms/app.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { codeCommitPullRequestHref } from "../codecommit-route.js"
import { FilterSidebar } from "./filter-sidebar.js"
import { PRRow } from "./pr-row.js"
import { RecentActivity } from "./recent-activity.js"
import {
  groupQueueFilters,
  isWithinQueueDateBounds,
  matchesQueueFilter,
  openSubStatuses,
  resolveQueueFacet,
  type QueueFacet
} from "./review-queue-state.js"
import styles from "./review-queue.module.css"
import { SearchBar } from "./search-bar.js"

type PullRequest = Domain.PullRequest

export const prListHref = (pr: Pick<PullRequest, "account" | "id" | "repositoryName">): string =>
  codeCommitPullRequestHref(
    pr.account.awsAccountId ?? pr.account.profile,
    String(pr.id),
    String(pr.repositoryName),
    String(pr.account.region)
  )

const replaceStatusFacet = (params: URLSearchParams, status: "approved" | "open" | "pending"): void => {
  const retained = params.getAll("f").filter((raw) => !raw.startsWith("status:") && raw !== "")
  params.delete("f")
  for (const raw of retained) params.append("f", raw)
  params.append("f", `status:${status}`)
}

export function PRList() {
  const appState = useAtomValue(appStateAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const { state: filterState, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  const prs = appState.pullRequests
  const isLoading = appState.status === "loading"

  const summary = useMemo(() => {
    let review = 0
    let pending = 0
    let approved = 0
    let open = 0
    for (const pr of prs) {
      if (pr.status !== "OPEN") continue
      open += 1
      if (pr.isApproved) approved += 1
      else pending += 1
      if (needsMyReview(pr, appState.currentUser)) review += 1
    }
    return { approved, open, pending, review }
  }, [appState.currentUser, prs])

  const sorted = useMemo(() => {
    if (prs.length === 0) return []

    const { filters, from, q, review, to } = filterState
    const filterLower = q.toLowerCase()
    const byGroup = groupQueueFilters(filters)
    const hasOpenSubStatus = filters.some((filter) => filter.key === "status" && openSubStatuses.has(filter.value))
    const hasLifecycle = filters.some(
      (filter) => filter.key === "status" && ["open", "merged", "closed"].includes(filter.value)
    )
    const requireOpen = hasOpenSubStatus && !hasLifecycle
    const fromMs = from !== undefined && from !== "" ? new Date(from).getTime() : undefined
    const toMs = to !== undefined && to !== "" ? new Date(to).getTime() : undefined
    const statusFilter = filters.find((filter) => filter.key === "status")

    return prs
      .filter((pr) => {
        if (
          q.length > 0 &&
          !pr.repositoryName.toLowerCase().includes(filterLower) &&
          !pr.title.toLowerCase().includes(filterLower) &&
          !pr.author.toLowerCase().includes(filterLower) &&
          !pr.sourceBranch.toLowerCase().includes(filterLower) &&
          !(pr.description?.toLowerCase().includes(filterLower) ?? false)
        ) {
          return false
        }
        if (requireOpen && pr.status !== "OPEN") return false
        if (![...byGroup.values()].every((group) => group.some((filter) => matchesQueueFilter(pr, filter)))) {
          return false
        }
        if (Number.isFinite(fromMs) || Number.isFinite(toMs)) {
          const timestamp =
            statusFilter?.value === "merged" || statusFilter?.value === "closed"
              ? pr.lastModifiedDate.getTime()
              : pr.creationDate.getTime()
          if (!isWithinQueueDateBounds(timestamp, fromMs, toMs)) return false
        }
        return !review || needsMyReview(pr, appState.currentUser)
      })
      .sort((left, right) => right.lastModifiedDate.getTime() - left.lastModifiedDate.getTime())
  }, [appState.currentUser, filterState, prs])

  const activeFacet = resolveQueueFacet(filterState)

  const applyFacet = useCallback(
    (facet: QueueFacet) => {
      setSearchParams(
        (previous) => {
          previous.delete("groupBy")
          previous.delete("mine")
          previous.delete("mineScope")
          previous.delete("review")
          previous.set("sortBy", "updated")

          if (appState.currentUser !== undefined && appState.currentUser !== "") {
            const retained = previous
              .getAll("f")
              .filter((raw) => raw !== `author:${appState.currentUser}` && raw !== "")
            previous.delete("f")
            for (const raw of retained) previous.append("f", raw)
          }

          replaceStatusFacet(previous, facet === "review" ? "open" : facet)
          if (facet === "review") previous.set("review", "1")
          return previous
        },
        { preventScrollReset: true, replace: true }
      )
    },
    [appState.currentUser, setSearchParams]
  )

  const profiles = useMemo(
    () => [...new Set(appState.accounts.filter((account) => account.enabled).map((account) => account.profile))],
    [appState.accounts]
  )
  const needsLogin = prs.length === 0 && profiles.length > 0
  const accountCount = new Set(sorted.map((pr) => pr.account.profile)).size
  const activity =
    appState.currentUser !== undefined && appState.currentUser !== "" ? (appState.notifications?.items ?? []) : []

  const listContent = (() => {
    if (sorted.length === 0 && isLoading) {
      return (
        <StatePanel
          announce="polite"
          className={styles.queueState}
          description={
            prs.length > 0
              ? `${prs.length} pull requests are available; the current view hides them while refresh continues.`
              : "Reading configured CodeCommit accounts and preparing the decision queue."
          }
          title="Loading pull requests"
          tone="progress"
        />
      )
    }

    if (sorted.length === 0) {
      const filtered = prs.length > 0
      return (
        <div className={styles.emptyStack}>
          <StatePanel
            className={styles.queueState}
            description={
              filtered
                ? `${prs.length} pull requests are cached, but none match the current search and filters.`
                : needsLogin
                  ? "A configured AWS session may have expired. Sign in to load its pull requests."
                  : "No pull requests are available from the configured accounts yet."
            }
            title={filtered ? "No pull requests match this view" : "The queue is empty"}
          />
          {filtered ? (
            <div className={styles.emptyActions}>
              <Button onClick={() => toggleFilter("status", "merged")} size="compact">
                Show merged
              </Button>
              <Button onClick={() => toggleFilter("status", "closed")} size="compact">
                Show closed
              </Button>
            </div>
          ) : null}
          {needsLogin ? (
            <Surface className={styles.ssoPanel} padding="compact" form="grouped">
              <Text as="h3" variant="card-title">
                Restore AWS sessions
              </Text>
              <Text tone="secondary" variant="meta">
                Sign in with each profile that should contribute to this queue.
              </Text>
              <div className={styles.ssoActions}>
                {profiles.map((profile) => (
                  <Button
                    className={styles.ssoButton}
                    key={profile}
                    leadingIcon="user"
                    onClick={() => ssoLogin({ payload: { profile } })}
                    size="compact"
                  >
                    {profile}
                  </Button>
                ))}
              </div>
              <LogInIcon aria-hidden="true" className={styles.ssoWatermark} />
            </Surface>
          ) : null}
        </div>
      )
    }

    if (filterState.groupBy !== "account") {
      return (
        <Surface className={styles.queueSurface} padding="none" form="grouped">
          {sorted.map((pr) => (
            <PRRow
              currentUser={appState.currentUser}
              key={`${pr.account.profile}:${pr.id}`}
              pr={pr}
              showUpdated
              to={prListHref(pr)}
            />
          ))}
        </Surface>
      )
    }

    const byAccount = new Map<string, Array<PullRequest>>()
    for (const pr of sorted) {
      const accountId = pr.account?.profile ?? "unknown"
      const group = byAccount.get(accountId)
      if (group !== undefined) group.push(pr)
      else byAccount.set(accountId, [pr])
    }

    return (
      <div className={styles.accountGroups}>
        {[...byAccount.entries()].map(([accountId, accountPrs], accountIndex) => (
          <section aria-labelledby={`account-group-${accountIndex}`} className={styles.accountGroup} key={accountId}>
            <div className={styles.accountHeading}>
              <Text as="h3" id={`account-group-${accountIndex}`} variant="label">
                {accountId}
              </Text>
              <Text tone="tertiary" variant="meta">
                {accountPrs.length} {accountPrs.length === 1 ? "pull request" : "pull requests"}
              </Text>
            </div>
            <Surface className={styles.queueSurface} padding="none" form="grouped">
              {accountPrs.map((pr) => (
                <PRRow
                  currentUser={appState.currentUser}
                  key={`${pr.account.profile}:${pr.id}`}
                  pr={pr}
                  to={prListHref(pr)}
                />
              ))}
            </Surface>
          </section>
        ))}
      </div>
    )
  })()

  const facets: ReadonlyArray<{ readonly count: number; readonly id: QueueFacet; readonly label: string }> = [
    { count: summary.review, id: "review", label: "Needs your review" },
    { count: summary.pending, id: "pending", label: "Waiting on others" },
    { count: summary.approved, id: "approved", label: "Approved" },
    { count: summary.open, id: "open", label: "All open" }
  ]

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.eyebrow}>
          <ServiceMark service="codecommit" size="compact" />
          <Text tone="secondary" variant="meta">
            Review queue
          </Text>
        </div>
        <Text as="h1" className={styles.title} variant="page-title">
          What needs a decision.
        </Text>
        <Text className={styles.lede} tone="secondary" variant="body-large">
          Open pull requests, ordered around your review work rather than repository noise.
        </Text>
      </header>

      <div aria-label="Pull request facets" className={styles.facets} role="group">
        {facets.map((facet) => (
          <button
            aria-pressed={activeFacet === facet.id}
            className={styles.facet}
            key={facet.id}
            onClick={() => applyFacet(facet.id)}
            type="button"
          >
            <span className={styles.facetLabel}>{facet.label}</span>
            <span aria-label={`${facet.count} pull requests`} className={styles.facetCount}>
              {facet.count}
            </span>
          </button>
        ))}
      </div>

      <section aria-labelledby="review-queue-heading" className={styles.queueSection}>
        <div className={styles.sectionHeading}>
          <Text as="h2" id="review-queue-heading" variant="section-title">
            Review queue
          </Text>
          <Text aria-live="polite" tone="tertiary" variant="meta">
            {sorted.length} {sorted.length === 1 ? "result" : "results"}
            {accountCount > 0 ? ` · ${accountCount} ${accountCount === 1 ? "AWS account" : "AWS accounts"}` : ""}
          </Text>
        </div>

        <div className={styles.controls}>
          <SearchBar />
          <FilterSidebar />
        </div>

        {listContent}
      </section>

      {activity.length > 0 ? <RecentActivity notifications={activity} /> : null}
    </div>
  )
}
