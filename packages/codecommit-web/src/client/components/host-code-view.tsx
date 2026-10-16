/** Controlled read-only Code view. Only normalized host DTOs enter; provider locators never do. @module */
import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Dialog, IconButton, Notice, StateLabel } from "@knpkv/rly/primitives"
import { useEffect, useId, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react"
import { canRenderCodeText } from "./host-diff-text.js"
import reviewPageStyles from "./review-page.module.css"
import type {
  CodeDetail,
  CodeDiffContentResult,
  CodeDiffResult,
  CodePullRequest,
  CodeQueue,
  CodeQueueQuery,
  CodeReference,
  CodeUnavailable
} from "../../host-contract.js"

export type CodeHostPage = "pull-requests" | "reviews" | "diffs"
export interface CodeReadState<A> {
  readonly value: A | null
  readonly loading: boolean
  readonly failure: "not_found" | "unauthorized" | "network" | "status" | "invalid_response" | "timeout" | null
}
export interface CodeHostViewProps {
  readonly active: boolean
  readonly page: CodeHostPage
  readonly queue: CodeReadState<CodeQueue>
  readonly detail: CodeReadState<CodeDetail>
  readonly diff: CodeReadState<CodeDiffResult>
  readonly content: CodeReadState<CodeDiffContentResult>
  readonly query: CodeQueueQuery
  readonly selected: CodeReference | null
  readonly selectedFile: number | null
  readonly tabs: Readonly<Record<CodeHostPage, { readonly label: string; readonly href: string }>>
  readonly hrefFor: (ref: CodeReference) => string
  /** Optional host-owned deliberate target navigation. Modified clicks keep the normal anchor behavior. */
  readonly onOpenReference?: (ref: CodeReference) => void
  readonly hrefForFile: (index: number) => string
  readonly nextHref: string | null
  readonly ownerUIHref: string | null
  readonly onSearch: (search: string) => void
  readonly onFilter: (filter: CodeQueueQuery["filter"]) => void
  readonly onClose: () => void
  readonly onRefresh: () => void
  /** Decline to use Dialog's default opener restore, or handle navigation focus after cleanup. */
  readonly restoreFocus?: (opener: HTMLElement | null) => boolean
  /** Optional host-owned recorded review body. Its read/focus owner stays outside changing content. */
  readonly reviewWorkspace?: ReactNode
  /** Retained-read diagnostics before the PR header. The host keeps its read/focus owner mounted separately. */
  readonly reviewBeforeDetail?: ReactNode
  /** Full-page review owner status. Only matching detail loading/failure/availability is deduplicated; independent detail failures remain visible. */
  readonly reviewStatus?: CodeReadState<CodeUnavailable>
  /** Recorded workspace checks in the full-page PR header. Absent adds no checks or status claim. */
  readonly reviewChecks?: ReactNode
}

const approvalWords = {
  approved: "Approved in cached reading",
  not_required: "No approval required in cached reading",
  waiting: "Cached approval waiting",
  unknown: "Approval state unknown"
} satisfies Record<CodePullRequest["approval"], string>
const unavailableWords = {
  not_configured: "Code has not been configured on this hub.",
  other_host: "Code is available only on its credential host’s own hub.",
  cache_unavailable:
    "The Code owner cache could not be read. Check the Code owner service and hub log on this host, then read again.",
  config_unavailable: "Code’s enabled accounts could not be read. Repair the configuration in the Code owner UI.",
  permission_required:
    "This read needs a saved always-allow grant. Open the Code owner UI on this host to review it, then read again.",
  denied: "The owner has denied this provider read. Review the policy in the Code owner UI.",
  sign_in_required: "The provider requires sign-in on this host. Open the Code owner UI there, then read again.",
  unavailable: "Code could not complete this read. Read again or check the Code owner UI on this host."
} satisfies Record<CodeUnavailable["reason"], string>
const failureWords = {
  not_found: "This pull request reference is no longer available.",
  unauthorized: "This hub could not verify your Tailscale identity.",
  network: "The hub could not be reached.",
  status: "The hub could not complete this read.",
  invalid_response: "The hub returned an unexpected reading.",
  timeout: "The Code read timed out."
} satisfies Record<NonNullable<CodeReadState<unknown>["failure"]>, string>
/** The owner refreshes every few minutes by default; a queue an hour behind its reading has stopped refreshing. */
const STALE_QUEUE_MILLIS = 3_600_000

/**
 * When the cache last heard from AWS, if that is over an hour before this reading: the newest row's fetch
 * time, which every successful owner refresh rewrites. Null when the queue is current or no row says.
 */
export const staleQueueSince = (queue: Extract<CodeQueue, { readonly _tag: "Ready" }>): number | null => {
  const fetched = queue.items.flatMap((item) => (item.observedAt === null ? [] : [item.observedAt]))
  if (fetched.length === 0) return null
  const newest = Math.max(...fetched)
  return queue.observedAt - newest > STALE_QUEUE_MILLIS ? newest : null
}

const date = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp)

const Unavailable = ({
  action,
  ownerUIHref,
  panel = false,
  value
}: {
  readonly value: CodeUnavailable
  readonly ownerUIHref: string | null
  readonly panel?: boolean
  readonly action?: ReactNode
}): ReactElement => {
  const body = (
    <>
      {value.reason === "other_host" && value.host !== null ? (
        <p>Code lives on {value.host}. Open that host’s hub.</p>
      ) : null}
      <p>{unavailableWords[value.reason]}</p>
      {ownerUIHref === null ? (
        <p>Use the Code owner UI on the credential host.</p>
      ) : (
        <a className="code-host-action" href={ownerUIHref} target="_blank" rel="noopener noreferrer">
          Open Code owner UI on this machine
        </a>
      )}
    </>
  )
  return (
    <div
      className={panel ? "code-host-notice code-review-status" : "code-host-notice"}
      data-code-read-notice={panel ? "unavailable" : undefined}
    >
      {panel ? (
        <>
          <div className="code-review-status-copy">
            <StateLabel icon="alert" label="Code unavailable" size="compact" tone="caution" />
            <div className="code-review-status-body">{body}</div>
          </div>
          {action}
        </>
      ) : (
        <>
          <h2>Code unavailable</h2>
          {body}
        </>
      )}
    </div>
  )
}

const Problem = ({
  announce = true,
  state
}: {
  readonly state: CodeReadState<unknown>
  readonly announce?: boolean
}): ReactElement | null =>
  state.failure === null ? null : (
    <p className="code-host-problem" role={announce ? "status" : undefined}>
      {failureWords[state.failure]} {state.value === null ? "" : "Showing the previous reading."}
    </p>
  )

/** Shared closed read-failure/availability words, without raw transport detail or command clients. */
export const CodeReadStatusView = ({
  action,
  announce = true,
  loadingLabel,
  ownerUIHref,
  presentation = "plain",
  state
}: {
  readonly state: CodeReadState<CodeUnavailable>
  readonly ownerUIHref: string | null
  readonly loadingLabel: string
  /** Defaults true for inserted loading/failure statuses. False lets a composed host own one stable live region. */
  readonly announce?: boolean
  /** Plain preserves existing embedding defaults. Panel opts into the full-page read-state styling. */
  readonly presentation?: "plain" | "panel"
  /**
   * Optional host-owned action in panel presentation only; absent renders none. It follows the copy
   * in the first visible panel, once even for retained loading/failure states. The host supplies its
   * callback and persistent focus owner. This view derives no retry or command authority.
   */
  readonly action?: ReactNode
}): ReactElement =>
  presentation === "panel" ? (
    <>
      {state.failure === null ? null : (
        <div className="code-review-status" data-code-read-notice="failure" role={announce ? "status" : undefined}>
          <div className="code-review-status-copy">
            <StateLabel icon="alert" label={failureWords[state.failure]} size="compact" tone="caution" />
            {state.value === null ? null : <p>Showing the previous reading.</p>}
          </div>
          {action}
        </div>
      )}
      {state.loading ? (
        <div className="code-review-pending" data-code-read-notice="loading" role={announce ? "status" : undefined}>
          <p>{loadingLabel}</p>
          {state.failure === null ? action : null}
        </div>
      ) : null}
      {state.value === null ? null : (
        <Unavailable
          panel
          value={state.value}
          ownerUIHref={ownerUIHref}
          action={state.failure === null && !state.loading ? action : undefined}
        />
      )}
    </>
  ) : (
    <>
      <Problem state={state} announce={announce} />
      {state.loading ? <p role={announce ? "status" : undefined}>{loadingLabel}</p> : null}
      {state.value === null ? null : <Unavailable value={state.value} ownerUIHref={ownerUIHref} />}
    </>
  )

/** Closed transport words shared by the visible read status and its host-owned completion announcement. */
export const codeReadFailureMessage = (reason: NonNullable<CodeReadState<never>["failure"]>): string =>
  failureWords[reason]

const Row = ({
  href,
  item,
  onOpen
}: {
  readonly item: CodePullRequest
  readonly href: string
  readonly onOpen?: () => void
}): ReactElement => (
  <li>
    <a
      data-code-ref={item.ref}
      className="code-host-row"
      href={href}
      onClick={(event) => {
        if (
          onOpen === undefined ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return
        event.preventDefault()
        onOpen()
      }}
    >
      <span className="code-host-provider">
        <ServiceMark service="codecommit" name="hidden" size="compact" />
      </span>
      <span className="code-host-row-copy">
        <small>
          {item.repository} / #{item.id}
        </small>
        <strong>{item.title}</strong>
        <span>
          {approvalWords[item.approval]}, {item.status.toLowerCase()}
        </span>
        <small>
          {item.author}, {item.observedAt === null ? "Cached reading time unknown" : `Cached ${date(item.observedAt)}`}
        </small>
      </span>
    </a>
  </li>
)

const Diff = ({
  cacheUpdatedAt,
  content,
  file,
  headingId,
  hrefForFile,
  ownerUIHref,
  state
}: {
  /** Names the section, which is the focus target when a pull request's diff opens on Diffs. */
  readonly headingId: string
  readonly state: CodeReadState<CodeDiffResult>
  readonly content: CodeReadState<CodeDiffContentResult>
  readonly file: number | null
  readonly hrefForFile: (index: number) => string
  readonly ownerUIHref: string | null
  readonly cacheUpdatedAt: number | null
}): ReactElement => (
  <section className="code-host-diff" tabIndex={-1} aria-labelledby={headingId} data-code-diff="">
    <h2 id={headingId}>Read-only diff</h2>
    <Problem state={state} />
    {state.loading ? <p role="status">Reading diff…</p> : null}
    {state.value?._tag === "Unavailable" ? <Unavailable value={state.value} ownerUIHref={ownerUIHref} /> : null}
    {state.value?._tag === "Ready" ? (
      <>
        <p>Read {date(state.value.diff.readAt)}.</p>
        <p>
          Revision {state.value.diff.revisionId}. {state.value.diff.files.length} files in this immutable reading.
        </p>
        <p>
          Base {state.value.diff.baseCommit}. Head {state.value.diff.headCommit}.
        </p>
        {cacheUpdatedAt !== null && cacheUpdatedAt !== state.value.diff.cacheUpdatedAt ? (
          <p className="code-host-problem">
            The cached pull request changed. This diff may be outdated. Use Read again to check it.
          </p>
        ) : null}
        {state.value.diff.files.length === 0 ? (
          <p>No changed files in this reading.</p>
        ) : (
          <nav aria-label="Changed files">
            <ul>
              {state.value.diff.files.map((entry) => (
                <li key={entry.index}>
                  <a href={hrefForFile(entry.index)} aria-current={file === entry.index ? "page" : undefined}>
                    <span>{entry.path}</span>
                    <small>{entry.status}</small>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {file !== null ? (
          <section className="code-host-file" aria-label="Selected file content">
            <Problem state={content} />
            {content.loading ? <p role="status">Reading file…</p> : null}
            {content.value?._tag === "Unavailable" ? (
              <Unavailable value={content.value} ownerUIHref={ownerUIHref} />
            ) : null}
            {content.value?._tag === "Ready" ? (
              content.value.content.state === "text" &&
              canRenderCodeText(content.value.content.before, content.value.content.after) ? (
                <div className="code-host-file-columns">
                  <section>
                    <h3>Before</h3>
                    <pre tabIndex={0}>{content.value.content.before ?? "File not present"}</pre>
                  </section>
                  <section>
                    <h3>After</h3>
                    <pre tabIndex={0}>{content.value.content.after ?? "File not present"}</pre>
                  </section>
                </div>
              ) : (
                <p>
                  {content.value.content.state === "binary"
                    ? "Binary content is not shown."
                    : "This file exceeds the display limit. Use the Code owner UI on the credential host to inspect it."}
                </p>
              )
            ) : null}
          </section>
        ) : null}
      </>
    ) : null}
  </section>
)

/** Import ./host/style.css and the application's rly stylesheet. All navigation remains host-owned. */
export const CodeHostView = (props: CodeHostViewProps): ReactElement => {
  const searchId = useId()
  const filterId = useId()
  const diffHeadingId = useId()
  const pageRoot = useRef<HTMLElement>(null)
  const previousSelection = useRef<CodeReference | null>(null)
  const reviewPage = props.selected !== null && props.page !== "diffs" && props.reviewWorkspace !== undefined
  useLayoutEffect(() => {
    const previous = previousSelection.current
    previousSelection.current = props.selected
    if (!props.active || previous === props.selected || pageRoot.current === null) return
    const modal = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')
    if (modal !== null && modal !== undefined && !pageRoot.current.contains(modal)) return
    if (reviewPage) pageRoot.current.focus({ preventScroll: true })
    else if (props.selected === null && previous !== null) {
      const row = pageRoot.current.querySelector<HTMLElement>(`[data-code-ref="${previous}"]`)
      const heading = pageRoot.current.querySelector<HTMLElement>("h1")
      const target = row ?? heading
      target?.focus({ preventScroll: true })
    }
  }, [props.active, props.selected, reviewPage])
  // Read diff from a pull request's sheet lands on the diff above the queue. Only an arrival from another page
  // moves focus: choosing a row on Diffs keeps it on the row the reader activated. It runs after the sheet closed.
  const previousPage = useRef<CodeHostPage>(props.page)
  useEffect(() => {
    const arrived = previousPage.current !== "diffs" && props.page === "diffs"
    previousPage.current = props.page
    if (!props.active || !arrived || props.selected === null) return
    pageRoot.current?.querySelector<HTMLElement>("[data-code-diff]")?.focus()
  }, [props.active, props.page, props.selected])
  const title = { "pull-requests": "Pull requests", reviews: "Reviews", diffs: "Diffs" } satisfies Record<
    CodeHostPage,
    string
  >
  const queue = props.queue.value
  const detail = props.detail.value
  const selectedItem = queue?._tag === "Ready" ? queue.items.find((item) => item.ref === props.selected) : undefined
  const detailUpdatedAt = detail?._tag === "Ready" && detail.item.ref === props.selected ? detail.item.updatedAt : null
  const cacheUpdatedAt =
    selectedItem === undefined
      ? detailUpdatedAt
      : detailUpdatedAt === null
        ? selectedItem.updatedAt
        : Math.max(selectedItem.updatedAt, detailUpdatedAt)
  if (reviewPage) {
    const reviewStatus = props.reviewStatus
    const detailUnavailable = detail?._tag === "Unavailable" ? detail : null
    const detailStatus: CodeReadState<CodeUnavailable> = {
      loading: props.detail.loading && reviewStatus?.loading !== true,
      failure: props.detail.failure === reviewStatus?.failure ? null : props.detail.failure,
      value:
        detailUnavailable !== null &&
        reviewStatus?.value?.reason === detailUnavailable.reason &&
        reviewStatus.value.host === detailUnavailable.host
          ? null
          : detailUnavailable
    }
    return (
      <section
        className={reviewPageStyles.page}
        data-code-review-page=""
        data-code-detail-state={
          props.detail.loading ? "Loading" : props.detail.failure !== null ? "Failed" : (detail?._tag ?? "Idle")
        }
        ref={pageRoot}
        tabIndex={-1}
        aria-label="Pull request review"
      >
        <header className={reviewPageStyles.heading}>
          <h1>Code</h1>
          <p>Pull requests, reviews and diffs</p>
        </header>
        <nav className={reviewPageStyles.pages} aria-label="Code pages">
          {(["pull-requests", "reviews", "diffs"] satisfies ReadonlyArray<CodeHostPage>).map((page) => (
            <a
              key={page}
              data-module-page={page}
              href={props.tabs[page].href}
              aria-current={props.page === page ? "page" : undefined}
              onClick={(event) => {
                if (
                  page !== props.page ||
                  event.button !== 0 ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  event.shiftKey
                )
                  return
                event.preventDefault()
                props.onClose()
              }}
            >
              {props.tabs[page].label}
            </a>
          ))}
        </nav>
        <div className={reviewPageStyles.body}>
          {props.reviewBeforeDetail}
          <Problem state={{ ...props.detail, failure: detailStatus.failure }} />
          {detailStatus.loading ? <p role="status">Reading cached details…</p> : null}
          {detailStatus.value !== null ? (
            <Unavailable value={detailStatus.value} ownerUIHref={props.ownerUIHref} />
          ) : null}
          {detail?._tag === "Ready" ? (
            <header className={reviewPageStyles.pullRequest} data-code-review-header="">
              <div className={reviewPageStyles.reference}>
                <span>{detail.item.repository}</span>
                <b>#{detail.item.id}</b>
              </div>
              <h2>{detail.item.title}</h2>
              <div className={reviewPageStyles.metadata}>
                <span>
                  <code>{detail.sourceBranch}</code> → <code>{detail.destinationBranch}</code>
                </span>
                <span>Opened by {detail.item.author}</span>
                <span>
                  Updated{" "}
                  {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(
                    detail.item.updatedAt
                  )}
                </span>
                <span>{approvalWords[detail.item.approval]}</span>
              </div>
              {props.reviewChecks === undefined || props.reviewChecks === null ? null : (
                <div className={reviewPageStyles.checks}>{props.reviewChecks}</div>
              )}
            </header>
          ) : null}
          {props.reviewWorkspace}
        </div>
      </section>
    )
  }
  return (
    <section className="code-host" ref={pageRoot}>
      <header className="code-host-intro">
        <h1 tabIndex={-1}>{title[props.page]}</h1>
        <p>
          {props.page === "reviews"
            ? "Cached approvals waiting. This list does not identify reviews requested of you."
            : props.page === "diffs"
              ? "Read immutable provider diffs using the owner's saved grants."
              : "Pull requests from this host's Code cache."}
        </p>
        {queue?._tag === "Ready" ? (
          <p>
            {queue.more ? "At least " : ""}
            {queue.items.length} cached pull {queue.items.length === 1 ? "request" : "requests"}. Queue checked{" "}
            {date(queue.observedAt)}.
          </p>
        ) : null}
      </header>
      <nav className="code-host-tabs" aria-label="Code pages">
        {(["pull-requests", "reviews", "diffs"] satisfies ReadonlyArray<CodeHostPage>).map((page) => (
          <a
            key={page}
            data-module-page={page}
            href={props.tabs[page].href}
            aria-current={props.page === page ? "page" : undefined}
          >
            {props.tabs[page].label}
          </a>
        ))}
      </nav>
      {queue?._tag === "Ready" && staleQueueSince(queue) !== null ? (
        <Notice
          tone="caution"
          action={
            <>
              {props.ownerUIHref === null ? null : (
                <a className="code-host-action" href={props.ownerUIHref} target="_blank" rel="noopener noreferrer">
                  Open Code owner UI
                </a>
              )}
              <Button size="compact" variant="quiet" onClick={props.onRefresh}>
                Read again
              </Button>
            </>
          }
        >
          <strong>Not refreshed since {date(staleQueueSince(queue) ?? queue.observedAt)}.</strong> The Code owner
          refreshes this cache from AWS. Its AWS sign-in may have expired. Open the Code owner UI to check, then read
          again.
        </Notice>
      ) : null}
      <div className="code-host-controls">
        <label htmlFor={searchId}>
          Find a pull request
          <input
            id={searchId}
            name="code-search"
            type="search"
            value={props.query.search}
            maxLength={256}
            onChange={(event) => props.onSearch(event.target.value)}
          />
        </label>
        {props.page === "reviews" ? null : (
          <label htmlFor={filterId}>
            Cached queue
            <select
              id={filterId}
              name="code-filter"
              value={props.query.filter}
              onChange={(event) => {
                const next = event.target.value
                if (next === "open" || next === "reviews" || next === "all") props.onFilter(next)
              }}
            >
              <option value="open">Open</option>
              <option value="reviews">Approvals waiting</option>
              <option value="all">All cached</option>
            </select>
          </label>
        )}
        <Button size="default" onClick={props.onRefresh}>
          Read again
        </Button>
      </div>
      {props.page === "diffs" ? (
        props.selected === null ? (
          <p>Choose a pull request to read its diff.</p>
        ) : props.reviewWorkspace !== undefined ? (
          props.reviewWorkspace
        ) : (
          <Diff
            state={props.diff}
            content={props.content}
            file={props.selectedFile}
            headingId={diffHeadingId}
            hrefForFile={props.hrefForFile}
            ownerUIHref={props.ownerUIHref}
            cacheUpdatedAt={cacheUpdatedAt}
          />
        )
      ) : null}
      <Problem state={props.queue} />
      {props.queue.loading ? <p role="status">Reading cached queue…</p> : null}
      {queue?._tag === "Unavailable" ? <Unavailable value={queue} ownerUIHref={props.ownerUIHref} /> : null}
      {queue?._tag === "Ready" ? (
        queue.items.length === 0 ? (
          <div className="code-host-empty">
            <h2>No cached pull requests match</h2>
            <p>Change the filter or search. This reading does not claim that the provider queue is empty.</p>
          </div>
        ) : (
          <ul className="code-host-queue" aria-label="Cached pull requests">
            {queue.items.map((item) => (
              <Row
                key={item.ref}
                item={item}
                href={props.hrefFor(item.ref)}
                {...(props.onOpenReference === undefined ? {} : { onOpen: () => props.onOpenReference?.(item.ref) })}
              />
            ))}
          </ul>
        )
      ) : null}
      {props.nextHref === null ? null : (
        <a className="code-host-action" href={props.nextHref}>
          Next cached page
        </a>
      )}
      <Dialog.Root
        open={props.active && props.selected !== null && props.page !== "diffs"}
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
      >
        <Dialog.Content
          title="Cached pull request"
          className="code-host-panel"
          {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
        >
          <IconButton
            className="code-host-close"
            icon="close"
            label="Close pull request"
            size="default"
            variant="quiet"
            onClick={props.onClose}
          />
          <Problem state={props.detail} />
          {props.detail.loading ? <p role="status">Reading cached details…</p> : null}
          {detail?._tag === "Unavailable" ? <Unavailable value={detail} ownerUIHref={props.ownerUIHref} /> : null}
          {detail?._tag === "Ready" ? (
            <section className="code-host-summary">
              <h3>{detail.item.title}</h3>
              <p>
                {detail.item.repository} / #{detail.item.id} by {detail.item.author}
              </p>
              {props.reviewWorkspace === undefined ? (
                <nav className="code-host-tabs code-host-summary-tabs" aria-label="Pull request views">
                  <span aria-current="page">Summary</span>
                  <a href={props.tabs.diffs.href}>Read diff</a>
                </nav>
              ) : null}
              <dl className="code-host-properties">
                <div>
                  <dt>Repository</dt>
                  <dd>{detail.item.repository}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>
                    {detail.sourceBranch} → {detail.destinationBranch}
                  </dd>
                </div>
                <div>
                  <dt>Review</dt>
                  <dd>{approvalWords[detail.item.approval]}</dd>
                </div>
                <div>
                  <dt>Read</dt>
                  <dd>
                    {detail.item.observedAt === null
                      ? "Cached reading time unknown"
                      : `Cached ${date(detail.item.observedAt)}`}
                  </dd>
                </div>
              </dl>
              <div className="code-host-description">{detail.description || "No cached description."}</div>
            </section>
          ) : null}
          {props.reviewWorkspace}
        </Dialog.Content>
      </Dialog.Root>
    </section>
  )
}
