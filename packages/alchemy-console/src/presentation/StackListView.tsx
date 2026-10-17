import { Icon } from "@knpkv/rly/foundations"
import { Button, Notice, Skeleton, Text } from "@knpkv/rly/primitives"
import { useId, type ReactElement } from "react"
import type { DiscoveryIssue, SourceFailureReason, StackList, StackSummary } from "../api.js"

/** Safe presentation labels supplied by the mounting application, without provider coordinates. */
export interface StackListCopy {
  readonly product: string
  readonly signInInstruction: string
}

/** A new read replaces the entire state, so loading and failures cannot display cached rows. */
export type StackListState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly list: StackList; readonly checkedAt: string }
  | { readonly _tag: "Unauthorized"; readonly reason: "bootstrap" | "session" }
  | { readonly _tag: "Failed"; readonly reason: typeof SourceFailureReason.Type | "transport" | "forbidden" }

export interface StackListViewProps {
  readonly state: StackListState
  readonly copy: StackListCopy
  readonly onReadAgain: () => void
  /** Omit when the mounting host has no detail view. Known counts and stages share this real UI destination. */
  readonly stackHref?: (stack: StackSummary) => string
}

const issueCopy = (issue: DiscoveryIssue) => {
  if (issue.source === "s3") {
    if (issue.reason === "denied") {
      return {
        tone: "critical",
        title: "State bucket access denied.",
        body: "Discovery is incomplete — stacks that could be read are listed.",
        hint: "Ask whoever manages access to the state bucket, then Read again."
      } satisfies { readonly tone: "critical"; readonly title: string; readonly body: string; readonly hint: string }
    }
    if (issue.reason === "authentication") {
      return {
        tone: "caution",
        title: "Sign-in required for the state bucket.",
        body: "Discovery is incomplete — stacks that could be read are listed.",
        hint: "Sign in for the state bucket, then Read again."
      } satisfies { readonly tone: "caution"; readonly title: string; readonly body: string; readonly hint: string }
    }
    return {
      tone: "caution",
      title: "State bucket discovery is incomplete.",
      body: "Some stacks in the state bucket may be missing. The stacks below were read normally.",
      hint: `Reason: ${issue.reason}. Check state bucket access, then Read again.`
    } satisfies { readonly tone: "caution"; readonly title: string; readonly body: string; readonly hint: string }
  }
  return {
    tone: "caution",
    title: "Local discovery is incomplete.",
    body: "A local state file couldn’t be read, so some local stacks may be missing. The stacks below were read normally.",
    hint: "Discovery only reads state; it doesn’t repair it. Check local state, then Read again."
  } satisfies { readonly tone: "caution"; readonly title: string; readonly body: string; readonly hint: string }
}

const IssueNotice = ({ issue }: { readonly issue: DiscoveryIssue }): ReactElement => {
  const message = issueCopy(issue)
  return (
    <Notice className="ac-notice" tone={message.tone}>
      <p>
        <strong>{message.title}</strong> {message.body}
      </p>
      <p className="ac-notice-hint">{message.hint}</p>
    </Notice>
  )
}

/** Group only returned rows; null metadata stays Unknown and zero remains a known count. */
const StackGroup = ({
  app,
  stackHref,
  stacks
}: {
  readonly app: string
  readonly stacks: ReadonlyArray<StackSummary>
  readonly stackHref: StackListViewProps["stackHref"]
}): ReactElement => {
  const headingId = useId()
  return (
    <section className="ac-group">
      <div className="ac-group-heading">
        <Text as="h2" id={headingId} variant="section-title">
          {app}
        </Text>
        <Text variant="meta" tone="secondary">
          {stacks.length} {stacks.length === 1 ? "stage" : "stages"}
        </Text>
      </div>
      <div className="ac-table-wrap">
        <table className="ac-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Backend</th>
              <th scope="col">Alchemy</th>
              <th scope="col">Last deploy</th>
              <th scope="col">Resources</th>
            </tr>
          </thead>
          <tbody>
            {stacks.map((stack) => (
              <tr key={stack.id}>
                <th scope="row">
                  {stackHref === undefined ? (
                    <span className="ac-stage">
                      <span className="ac-sr-only">{app} </span>
                      {stack.stage}
                    </span>
                  ) : (
                    <a className="ac-stage ac-list-link" data-rly-hit-area href={stackHref(stack)}>
                      <span className="ac-sr-only">{app} </span>
                      {stack.stage}
                    </a>
                  )}
                </th>
                <td>
                  <span className="ac-sr-only">Backend: </span>
                  {stack.backend === "s3" ? "State bucket" : "Local"}
                </td>
                <td className="ac-version">
                  <span className="ac-mobile-label">Alchemy </span>
                  {stack.alchemyVersion ?? "Unknown"}
                </td>
                <td>
                  <span className="ac-mobile-label">Last deploy </span>
                  {stack.lastDeploy ?? "Unknown"}
                </td>
                <td className={stackHref === undefined ? undefined : "ac-list-count"}>
                  <span className="ac-mobile-label">Resources </span>
                  {stack.resourceCount === null ? (
                    "Unknown"
                  ) : stackHref === undefined ? (
                    stack.resourceCount
                  ) : (
                    <a
                      className="ac-list-link"
                      data-rly-hit-area
                      href={stackHref(stack)}
                      aria-label={`${app} ${stack.stage}: ${stack.resourceCount} resources`}
                    >
                      {stack.resourceCount}
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const Reading = (): ReactElement => (
  <div className="ac-skeletons" aria-hidden="true">
    {["first", "second", "third"].map((name) => (
      <div className={`ac-skeleton-group ac-skeleton-${name}`} key={name}>
        <Skeleton className="ac-skeleton-heading" />
        <Skeleton className="ac-skeleton-body" variant="block" />
      </div>
    ))}
  </div>
)

/** Controlled module content for the local console or a host shell; no browser storage or data fetching. */
export const StackListView = ({ copy, onReadAgain, stackHref, state }: StackListViewProps): ReactElement => {
  const stateTitleId = useId()
  const empty = state._tag === "Ready" && state.list.stacks.length === 0 && state.list.issues.length === 0
  const issues =
    state._tag === "Ready"
      ? state.list.issues.filter(
          (issue, index, all) =>
            all.findIndex((candidate) => candidate.source === issue.source && candidate.reason === issue.reason) ===
            index
        )
      : []
  const apps = state._tag === "Ready" ? [...new Set(state.list.stacks.map((stack) => stack.app))].sort() : []
  const summary =
    state._tag === "Loading"
      ? "Looking in local state and the state bucket…"
      : state._tag === "Ready"
        ? issues.length > 0
          ? `${state.list.stacks.length} stacks found · discovery incomplete`
          : `${state.list.stacks.length} ${state.list.stacks.length === 1 ? "stack" : "stacks"} · ${apps.length} ${apps.length === 1 ? "app" : "apps"}`
        : state._tag === "Unauthorized"
          ? state.reason === "bootstrap"
            ? "Sign-in failed or link already used."
            : `Your ${copy.product} session has ended.`
          : "Stacks are unavailable right now."
  return (
    <div className="ac-stacks">
      <header className="ac-list-header">
        <Text as="h1" className="ac-title" variant="page-title">
          Stacks
        </Text>
        <div className="ac-list-lead">
          <Text as="p" className="ac-description" tone="secondary">
            Infrastructure state from local discovery and the state bucket. Read-only.
          </Text>
          {empty || state._tag === "Unauthorized" || state._tag === "Failed" ? null : (
            <Button className="ac-read" disabled={state._tag === "Loading"} onClick={onReadAgain}>
              {state._tag === "Loading" ? "Reading…" : "Read again"}
            </Button>
          )}
        </div>
      </header>
      <div className="ac-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {summary}
      </div>
      {issues.map((issue) => (
        <IssueNotice issue={issue} key={`${issue.source}-${issue.reason}`} />
      ))}
      {state._tag === "Unauthorized" ? (
        <section className="ac-state-panel" aria-labelledby={stateTitleId}>
          <div className="ac-state-label ac-state-caution">
            <Icon name="alert" size="small" decorative />
            <span>{state.reason === "bootstrap" ? "Sign-in failed" : "Signed out"}</span>
          </div>
          <Text as="h2" id={stateTitleId} className="ac-state-title" variant="section-title">
            {state.reason === "bootstrap"
              ? "Sign-in failed or link already used."
              : `Your ${copy.product} session has ended.`}
          </Text>
          <Text as="p" className="ac-state-body" tone="secondary">
            Sign in again to see stacks.
          </Text>
          <Text as="p" className="ac-state-instruction" variant="meta" tone="secondary">
            {copy.signInInstruction}
          </Text>
        </section>
      ) : state._tag === "Failed" ? (
        <section className="ac-state-panel" aria-labelledby={stateTitleId}>
          <div className="ac-state-label ac-state-critical">
            <Icon name="alert" size="small" decorative />
            <span>Unavailable</span>
          </div>
          <Text as="h2" id={stateTitleId} className="ac-state-title" variant="section-title">
            Stacks are unavailable right now.
          </Text>
          <Text as="p" className="ac-state-body" tone="secondary">
            The stack list couldn’t be read, so no stacks are shown. Nothing was changed.
          </Text>
          <Button className="ac-read" onClick={onReadAgain}>
            Retry
          </Button>
        </section>
      ) : empty ? (
        <div className="ac-empty">
          <span className="ac-empty-creature" aria-hidden="true" />
          <Text as="h2" className="ac-empty-title" variant="section-title">
            No stacks found in local state or the state bucket.
          </Text>
          <Text as="p" className="ac-empty-description" tone="secondary">
            Local discovery and the state bucket returned no stack state.
          </Text>
          <Button className="ac-read" onClick={onReadAgain}>
            Read again
          </Button>
          <Text as="p" className="ac-empty-foot" variant="meta" tone="secondary">
            Checked {state.checkedAt} · stacks appear here after their first deployment from the CLI.
          </Text>
        </div>
      ) : (
        <div className="ac-results" aria-busy={state._tag === "Loading"}>
          <Text as="p" className="ac-summary" variant="meta" tone="secondary">
            {summary}
          </Text>
          {state._tag === "Loading" ? (
            <Reading />
          ) : state._tag === "Ready" ? (
            apps.map((app) => (
              <StackGroup
                app={app}
                key={app}
                stacks={state.list.stacks.filter((stack) => stack.app === app)}
                stackHref={stackHref}
              />
            ))
          ) : null}
          {state._tag === "Ready" && state.list.stacks.length === 0 ? (
            <Text as="p" tone="secondary">
              No stacks could be read. Discovery is incomplete.
            </Text>
          ) : null}
        </div>
      )}
    </div>
  )
}
