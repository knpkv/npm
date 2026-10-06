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
import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { LogInIcon } from "lucide-react"
import { useCallback, useMemo } from "react"
import { queuePullRequests } from "../utils/queuePullRequests.js"
import { useNavigate, useSearchParams } from "react-router"
import { appStateAtom, notificationsSsoLoginAtom } from "../atoms/app.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { codeCommitPullRequestHref } from "../codecommit-route.js"
import { emptyQueueCause, streamConnectionAtom, streamRetryAtom, streamSnapshotSeenAtom } from "../connection.js"
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
import { needsYourReview } from "./workbench-queue.js"

type PullRequest = Domain.PullRequest

export const prListHref = (pr: Pick<PullRequest, "account" | "id" | "repositoryName">): string =>
  codeCommitPullRequestHref(pr.account.profile, String(pr.id), String(pr.repositoryName), String(pr.account.region))

export const prListKey = (pr: Pick<PullRequest, "account" | "id" | "repositoryName">): string =>
  `${pr.account.awsAccountId ?? pr.account.profile}:${String(pr.id)}:${String(pr.repositoryName)}:${String(pr.account.region)}`

const replaceStatusFacet = (params: URLSearchParams, status: "approved" | "open" | "pending"): void => {
  const retained = params.getAll("f").filter((raw) => !raw.startsWith("status:") && raw !== "")
  params.delete("f")
  for (const raw of retained) params.append("f", raw)
  params.append("f", `status:${status}`)
}

export function PRList() {
  const appState = useAtomValue(appStateAtom)
  const connection = useAtomValue(streamConnectionAtom)
  const snapshotSeen = useAtomValue(streamSnapshotSeenAtom)
  const setRetry = useAtomSet(streamRetryAtom)
  const navigate = useNavigate()
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const { state: filterState, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  // The queue hides accounts the user switched off; their rows stay cached so
  // re-enabling needs no refetch, and URL-addressable views still resolve them.
  const prs = useMemo(
    () => queuePullRequests(appState),
    // Keyed on the queue's own inputs rather than the whole state object, which
    // the SSE hook replaces on every payload.
    [appState.enabledProfiles, appState.pullRequests]
  )
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
      if (needsYourReview(pr, appState.currentUser)) review += 1
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
        return !review || needsYourReview(pr, appState.currentUser)
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

  const enabledAccounts = appState.enabledProfiles?.length ?? profiles.length
  // A zero is only true once an account's pull requests were read: not before the first snapshot, nor
  // while the first sync runs or waits for permission.
  const countsKnown = snapshotSeen && (prs.length > 0 || (!isLoading && appState.permissionPrompt?.category !== "read"))

  const listContent = (() => {
    // Before the first snapshot only the connection is known; after it, the snapshot says why it's empty.
    if (sorted.length === 0) {
      const cause = emptyQueueCause({
        cachedPullRequests: prs.length,
        connection,
        detectedAccounts: appState.accounts.length,
        enabledAccounts,
        snapshotSeen
      })
      switch (cause._tag) {
        case "Connecting":
          return (
            <StatePanel
              announce="polite"
              className={styles.queueState}
              description="Waiting for the first update from the CodeCommit server."
              title="Connecting"
              tone="progress"
            />
          )
        case "Unauthenticated":
          return (
            <StatePanel
              className={styles.queueState}
              description={cause.detail}
              title="This browser isn't signed in"
              tone="caution"
            />
          )
        case "Failed":
          return (
            <StatePanel
              action={
                <Button onClick={() => setRetry((count) => count + 1)} size="compact">
                  Retry now
                </Button>
              }
              announce="polite"
              className={styles.queueState}
              description={cause.retrying ? `${cause.cause} Trying again shortly.` : `${cause.cause} Retries stopped.`}
              title="Can't reach the CodeCommit server"
              tone="critical"
            />
          )
        case "NoAccounts":
          return (
            <StatePanel
              action={
                <Button onClick={() => navigate("/settings")} size="compact" variant="primary">
                  Set up accounts
                </Button>
              }
              className={styles.queueState}
              description="Add an AWS profile that can read CodeCommit, and its open pull requests appear here."
              title="No AWS profiles yet"
            />
          )
        case "NoneSwitchedOn":
          return (
            <StatePanel
              action={
                <Button onClick={() => navigate("/settings")} size="compact" variant="primary">
                  Choose accounts
                </Button>
              }
              className={styles.queueState}
              description={`${String(cause.detected)} AWS ${cause.detected === 1 ? "profile was" : "profiles were"} found, but none is switched on.`}
              title="No account is switched on"
            />
          )
        case "Filtered":
        case "NothingOpen":
          break
      }
    }

    // A read waiting on the reader's answer is why nothing has loaded: say that, not "Loading".
    const readPrompt = appState.permissionPrompt?.category === "read" ? appState.permissionPrompt : undefined
    if (sorted.length === 0 && readPrompt !== undefined) {
      return (
        <StatePanel
          announce="polite"
          className={styles.queueState}
          description={`${readPrompt.context} waits for your answer in the bar above: allow it once, or allow every read.`}
          title="Waiting for your permission"
          tone="caution"
        />
      )
    }

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
                  : `No open pull requests in ${String(enabledAccounts)} ${enabledAccounts === 1 ? "account" : "accounts"}.`
            }
            title={filtered ? "No pull requests match this view" : "Nothing open"}
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
            <PRRow currentUser={appState.currentUser} key={prListKey(pr)} pr={pr} showUpdated to={prListHref(pr)} />
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
                <PRRow currentUser={appState.currentUser} key={prListKey(pr)} pr={pr} to={prListHref(pr)} />
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
        <Text as="h1" className={styles.title} variant="page-title">
          What needs a decision.
        </Text>
        <Text className={styles.lede} tone="secondary" variant="body-large">
          Open pull requests, ordered around your review work rather than repository noise.
        </Text>
      </header>

      {/* Nothing to count until an account exists: no row of zeros on a first run. */}
      {snapshotSeen && enabledAccounts === 0 && appState.pullRequests.length === 0 ? null : (
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
              {/* Unknown until the first snapshot: never a 0 that the page can't vouch for. */}
              <span aria-label={countsKnown ? `${facet.count} pull requests` : "unknown"} className={styles.facetCount}>
                {countsKnown ? facet.count : "—"}
              </span>
            </button>
          ))}
        </div>
      )}

      <section aria-labelledby="review-queue-heading" className={styles.queueSection}>
        <div className={styles.sectionHeading}>
          <Text as="h2" id="review-queue-heading" variant="section-title">
            Review queue
          </Text>
          {snapshotSeen ? (
            <Text aria-live="polite" tone="secondary" variant="meta">
              {sorted.length} {sorted.length === 1 ? "result" : "results"}
              {accountCount > 0 ? `, ${accountCount} ${accountCount === 1 ? "AWS account" : "AWS accounts"}` : ""}
            </Text>
          ) : null}
        </div>

        {/* Search and filters only once there is something to search. */}
        {snapshotSeen && (enabledAccounts > 0 || appState.pullRequests.length > 0) ? (
          <div className={styles.controls}>
            <SearchBar />
            <FilterSidebar />
          </div>
        ) : null}

        {listContent}
      </section>

      {activity.length > 0 ? <RecentActivity notifications={activity} /> : null}
    </div>
  )
}
