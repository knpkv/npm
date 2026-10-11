/** Controlled read-only Code view. Only normalized host DTOs enter; provider locators never do. @module */
import { ServiceMark } from "@knpkv/rly/patterns"
import { Button, Dialog, IconButton } from "@knpkv/rly/primitives"
import { useId, type ReactElement } from "react"
import { canRenderCodeText } from "./host-diff-text.js"
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
}

const approvalWords = {
  approved: "Approved in cached reading",
  not_required: "No approval required in cached reading",
  waiting: "Cached approval waiting",
  unknown: "Approval state unknown"
} satisfies Record<CodePullRequest["approval"], string>
const unavailableWords = {
  not_configured: "Code has not been configured on this hub.",
  other_host: "Code is available only on its credential host's own hub.",
  cache_unavailable: "The Code owner cache could not be read. Start the Code owner UI on this host, then read again.",
  config_unavailable: "Code's enabled accounts could not be read. Repair the configuration in the Code owner UI.",
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
const date = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp)

const Unavailable = ({
  ownerUIHref,
  value
}: {
  readonly value: CodeUnavailable
  readonly ownerUIHref: string | null
}): ReactElement => (
  <div className="code-host-notice">
    <h2>Code unavailable</h2>
    {value.reason === "other_host" && value.host !== null ? (
      <p>Code lives on {value.host}. Open that host's hub.</p>
    ) : null}
    <p>{unavailableWords[value.reason]}</p>
    {ownerUIHref === null ? (
      <p>Use the Code owner UI on the credential host. Its loopback address cannot be opened from this device.</p>
    ) : (
      <a className="code-host-action" href={ownerUIHref} target="_blank" rel="noopener noreferrer">
        Open Code owner UI on this machine
      </a>
    )}
  </div>
)

const Problem = ({ state }: { readonly state: CodeReadState<unknown> }): ReactElement | null =>
  state.failure === null ? null : (
    <p className="code-host-problem" role="status">
      {failureWords[state.failure]} {state.value === null ? "" : "Showing the previous reading."}
    </p>
  )

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
  hrefForFile,
  ownerUIHref,
  state
}: {
  readonly state: CodeReadState<CodeDiffResult>
  readonly content: CodeReadState<CodeDiffContentResult>
  readonly file: number | null
  readonly hrefForFile: (index: number) => string
  readonly ownerUIHref: string | null
  readonly cacheUpdatedAt: number | null
}): ReactElement => (
  <section className="code-host-diff">
    <h2>Read-only diff</h2>
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
  return (
    <section className="code-host">
      <header className="code-host-intro">
        <h1>{title[props.page]}</h1>
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
      {props.page === "diffs" ? (
        props.selected === null ? (
          <p>Choose a pull request to read its diff.</p>
        ) : (
          <Diff
            state={props.diff}
            content={props.content}
            file={props.selectedFile}
            hrefForFile={props.hrefForFile}
            ownerUIHref={props.ownerUIHref}
            cacheUpdatedAt={cacheUpdatedAt}
          />
        )
      ) : null}
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
              <nav className="code-host-tabs code-host-summary-tabs" aria-label="Pull request views">
                <span aria-current="page">Summary</span>
                <a href={props.tabs.diffs.href}>Read diff</a>
              </nav>
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
        </Dialog.Content>
      </Dialog.Root>
    </section>
  )
}
