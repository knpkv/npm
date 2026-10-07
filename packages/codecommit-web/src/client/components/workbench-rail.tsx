/**
 * The Workbench queue rail: one region beside the open pull request listing what needs your
 * review, your own pull requests and why each is stuck, and what you are watching.
 *
 * The list is one tab stop. Arrow keys, Home and End move between rows; Enter follows the link.
 * The open pull request is marked with `aria-current="page"`.
 *
 * @module
 */
import { approvalOf } from "@knpkv/codecommit-core/Domain.js"
import { useAtomValue } from "@effect/atom-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { appStateAtom } from "../atoms/app.js"
import type { CodeCommitPullRequestRouteCoordinates } from "../codecommit-route.js"
import { queuePullRequests } from "../utils/queuePullRequests.js"
import { selectCodeCommitPullRequest } from "./pr-detail.js"
import { prListHref, prListKey } from "./pr-list.js"
import styles from "./workbench-rail.module.css"
import {
  callerOf,
  formatSpan,
  QUIET_AFTER_MS,
  type WorkbenchGroup,
  type WorkbenchQueue,
  workbenchQueue,
  type WorkbenchRow,
  WorkbenchSummary
} from "./workbench-queue.js"

const groupTitle = {
  pool: "Open to a role pool",
  review: "Needs your review",
  unsorted: "Open pull requests",
  watching: "Watching",
  yours: "Yours"
} satisfies Readonly<Record<WorkbenchGroup, string>>

const stuckText = (row: WorkbenchRow): string | undefined => {
  switch (row.stuck) {
    case "conflicts":
      return "conflicts with the destination"
    case "quiet":
      return `quiet ${formatSpan(row.quietMs)}`
    case "approvals":
      return row.rule === undefined
        ? "waiting for approvals"
        : `${row.rule.approved}/${row.rule.required} ${row.rule.name}`
    case "unverified":
      return "approval state unknown"
    case "ready":
      return approvalOf(row.pullRequest)._tag === "NotRequired"
        ? "no approval required, not merged"
        : "approved, not merged"
    case undefined:
      return undefined
  }
}

/** One caption per row; only the blocking fact carries ink. */
const RowCaption = ({ currentUser, row }: { readonly row: WorkbenchRow; readonly currentUser: string | undefined }) => {
  const pullRequest = row.pullRequest
  const who = currentUser !== undefined && row.group === "yours" ? "you" : pullRequest.author
  const blocking = row.stuck === "conflicts" || row.stuck === "quiet"
  const status =
    row.stuck !== undefined
      ? stuckText(row)
      : row.rule === undefined
        ? undefined
        : `${row.rule.approved}/${row.rule.required} ${row.rule.name}`
  const activity =
    row.stuck === "quiet"
      ? undefined
      : row.quietMs > QUIET_AFTER_MS
        ? `quiet ${formatSpan(row.quietMs)}`
        : `active ${formatSpan(row.quietMs)} ago`
  return (
    <span className={styles.caption}>
      {who}
      {status === undefined ? null : (
        <>
          {", "}
          <span className={blocking ? styles.blocking : undefined}>{status}</span>
        </>
      )}
      {row.stuck === undefined && !pullRequest.isMergeable ? (
        <>
          {", "}
          <span className={styles.blocking}>conflicts</span>
        </>
      ) : null}
      {activity === undefined ? null : `, ${activity}`}
    </span>
  )
}

const Summary = ({ summary }: { readonly summary: WorkbenchSummary }) =>
  WorkbenchSummary.$match(summary, {
    Clear: ({ pooled }) => (
      <p className={styles.summary}>
        {pooled === 0 ? (
          <strong>Nothing waits on your review.</strong>
        ) : (
          <>
            <strong>Nothing waits on you by name.</strong>{" "}
            {pooled === 1 ? "1 pull request waits" : `${pooled} pull requests wait`} on a role pool you may be in.
          </>
        )}
      </p>
    ),
    Unknown: () => (
      <p className={styles.summary}>
        <strong>Can't tell what waits on you.</strong> No caller identity resolved, so every open pull request is
        listed.
      </p>
    ),
    Waiting: ({ count, oldest }) => (
      <p className={styles.summary}>
        <strong>{count === 1 ? "1 pull request waits" : `${count} pull requests wait`} on your review.</strong> Oldest
        open for <span className={styles.number}>{formatSpan(oldest.openMs)}</span>.
      </p>
    )
  })

/**
 * The queue rail. `route` is the pull-request URL open beside it; it is resolved against the whole
 * cache exactly as the PR page resolves it, so an ambiguous route marks no row.
 */
export function WorkbenchRail({ route }: { readonly route?: CodeCommitPullRequestRouteCoordinates | undefined }) {
  const appState = useAtomValue(appStateAtom)
  // Ages are measured when the queue data changes, which the server pushes on every refresh.
  const queue = useMemo(() => workbenchQueue(queuePullRequests(appState), callerOf(appState), new Date()), [appState])
  const open = route === undefined ? null : selectCodeCommitPullRequest(appState.pullRequests, route).pullRequest
  return (
    <WorkbenchRailView
      currentKey={open === null ? undefined : prListKey(open)}
      currentUser={appState.currentUser}
      queue={queue}
    />
  )
}

/** The rail's rendering, separate from app state so it can be exercised directly. */
export function WorkbenchRailView({
  currentKey,
  currentUser,
  queue
}: {
  readonly currentKey?: string | undefined
  readonly currentUser: string | undefined
  readonly queue: WorkbenchQueue
}) {
  const list = useRef<HTMLDivElement>(null)
  // The roving tab stop: the row arrow keys last reached, reset when the open pull request changes,
  // and falling back to the open row, then the first, when its row leaves the queue.
  const [activeKey, setActiveKey] = useState(currentKey)
  useEffect(() => setActiveKey(currentKey), [currentKey])
  const keys = queue.rows.map((row) => prListKey(row.pullRequest))
  const tabStop = [activeKey, currentKey].find((key) => key !== undefined && keys.includes(key)) ?? keys[0]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? [])
    const index = links.findIndex((link) => link === document.activeElement)
    const target =
      event.key === "ArrowDown"
        ? links[Math.min(links.length - 1, index + 1)]
        : event.key === "ArrowUp"
          ? links[Math.max(0, index - 1)]
          : event.key === "Home"
            ? links[0]
            : event.key === "End"
              ? links.at(-1)
              : undefined
    if (target === undefined) return
    event.preventDefault()
    setActiveKey(target.dataset["row"])
    target.focus()
  }
  // Rows arrive sorted by group, so the groups and their order follow from the rows themselves.
  const groups = [...new Set(queue.rows.map((row) => row.group))].map((group) => ({
    group,
    rows: queue.rows.filter((row) => row.group === group)
  }))
  return (
    <section aria-labelledby="workbench-queue-title" className={styles.region}>
      <header className={styles.head}>
        <h2 className={styles.title} id="workbench-queue-title">
          Queue <span className={styles.count}>{queue.rows.length}</span>
        </h2>
      </header>
      <div className={styles.body}>
        <Summary summary={queue.summary} />
        <div className={styles.groups} onKeyDown={onKeyDown} ref={list}>
          {groups.map(({ group, rows }) => (
            <section aria-labelledby={`workbench-group-${group}`} className={styles.group} key={group}>
              <h3 className={styles.groupTitle} id={`workbench-group-${group}`}>
                {groupTitle[group]} <span className={styles.count}>{rows.length}</span>
              </h3>
              <ul className={styles.rows}>
                {rows.map((row) => (
                  <li key={prListKey(row.pullRequest)}>
                    <Link
                      aria-current={prListKey(row.pullRequest) === currentKey ? "page" : undefined}
                      className={styles.row}
                      data-row={prListKey(row.pullRequest)}
                      tabIndex={prListKey(row.pullRequest) === tabStop ? 0 : -1}
                      to={prListHref(row.pullRequest)}
                    >
                      <span className={styles.repo}>
                        {row.pullRequest.repositoryName} #{row.pullRequest.id}
                      </span>
                      <span className={styles.age}>{formatSpan(row.openMs)}</span>
                      <span className={styles.rowTitle}>{row.pullRequest.title}</span>
                      <RowCaption currentUser={currentUser} row={row} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {queue.rows.length === 0 ? (
            <p className={styles.empty}>No open pull requests involve you. New ones appear after the next refresh.</p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
