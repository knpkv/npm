import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Predicate from "effect/Predicate"
import { encodePullRequestCoordinates } from "../../pull-request-coordinates.js"
import { type CodeCommitPullRequestRouteCoordinates, matchesCodeCommitPullRequestRoute } from "../codecommit-route.js"

/** Use the discovered account as the durable sandbox key, with profile identity for undiscovered accounts. */
export const sandboxAccountIdForPullRequest = (pullRequest: Pick<Domain.PullRequest, "account">): string =>
  pullRequest.account.awsAccountId !== undefined && pullRequest.account.awsAccountId.length > 0
    ? pullRequest.account.awsAccountId
    : pullRequest.account.profile

export const sandboxMatchesPullRequest = (
  sandbox: {
    readonly awsAccountId: string
    readonly pullRequestId: string
    readonly repositoryName: string
    readonly region?: string | null
  },
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean =>
  sandbox.awsAccountId === sandboxAccountIdForPullRequest(pullRequest) &&
  sandbox.pullRequestId === String(pullRequest.id) &&
  sandbox.repositoryName === String(pullRequest.repositoryName) &&
  sandbox.region === String(pullRequest.account.region)

/** A sandbox is reusable only while it can still serve this pull request. */
export const isReusableSandbox = (
  sandbox: Parameters<typeof sandboxMatchesPullRequest>[0] & { readonly status: string },
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean =>
  sandbox.status !== "stopped" &&
  sandbox.status !== "stopping" &&
  sandbox.status !== "error" &&
  sandboxMatchesPullRequest(sandbox, pullRequest)

/** Detect a matching sandbox whose stop is still in flight. */
export const isStoppingSandbox = (
  sandbox: Parameters<typeof sandboxMatchesPullRequest>[0] & { readonly status: string },
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean => sandbox.status === "stopping" && sandboxMatchesPullRequest(sandbox, pullRequest)

/** Block fallback-account creation when an active numeric sandbox cannot be attributed safely. */
export const hasFallbackSandboxCollision = (
  sandboxes: ReadonlyArray<Parameters<typeof sandboxMatchesPullRequest>[0] & { readonly status?: string }>,
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean =>
  (pullRequest.account.awsAccountId === undefined || pullRequest.account.awsAccountId.length === 0) &&
  sandboxes.some(
    (sandbox) =>
      /^\d{12}$/u.test(sandbox.awsAccountId) &&
      sandbox.awsAccountId !== pullRequest.account.profile &&
      sandbox.status !== "stopped" &&
      sandbox.status !== "error" &&
      sandbox.pullRequestId === String(pullRequest.id) &&
      sandbox.repositoryName === String(pullRequest.repositoryName) &&
      sandbox.region === String(pullRequest.account.region)
  )

/** Keep review API requests bound to the exact PR shown by this page. */
export const reviewApiAccountId = (
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): string => {
  if (pullRequest.account.awsAccountId === undefined || pullRequest.account.awsAccountId.length === 0) {
    return pullRequest.account.profile
  }
  return encodePullRequestCoordinates({
    accountId: pullRequest.account.awsAccountId,
    pullRequestId: pullRequest.id,
    repositoryName: pullRequest.repositoryName,
    region: pullRequest.account.region
  })
}

/** Keep optimistic comment state isolated to one exact pull-request coordinate. */
export const commentNavigationIdentityForCoordinates = (
  accountId: string | undefined,
  pullRequestId: string | undefined,
  repositoryName: string | undefined,
  region: string | undefined
): string => JSON.stringify([accountId ?? "", pullRequestId ?? "", repositoryName ?? "", region ?? ""])

/** Select a cached PR only when the route identifies exactly one coordinate. */
export const selectCodeCommitPullRequest = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  route: CodeCommitPullRequestRouteCoordinates
) => {
  const matches = pullRequests.filter((candidate) => matchesCodeCommitPullRequestRoute(candidate, route))
  return {
    pullRequest: matches.length === 1 ? (matches[0] ?? null) : null,
    ambiguous: matches.length > 1
  }
}

export const isTextInputTarget = (target: EventTarget | null): boolean => {
  const tagName = Predicate.hasProperty(target, "tagName") ? target.tagName : undefined
  return tagName === "INPUT" || tagName === "TEXTAREA"
}

/** The focused element's tag, read from a key event's target; null when the target is not an element. */
export const focusedElement = (target: EventTarget | null): Pick<Element, "tagName"> | null =>
  Predicate.hasProperty(target, "tagName") && Predicate.isString(target.tagName) ? { tagName: target.tagName } : null

/**
 * True when Enter on the focused element already does something (follow a link, press a button),
 * so the page-wide Enter shortcut must not also fire. Used by the PR page's keydown handler.
 */
export const ownsEnterKey = (target: Pick<Element, "tagName"> | null): boolean => {
  const tagName = target?.tagName
  return tagName === "A" || tagName === "BUTTON" || tagName === "SELECT" || tagName === "SUMMARY"
}

/**
 * True when a key event's path (`event.composedPath()`) crosses an open dialog, native `<dialog
 * open>` or an ARIA `role="dialog"` (Radix and rly Sheet render those): Esc there closes the
 * dialog, so the PR page's own shortcuts (Esc back to the queue, Enter/o console, `.` sandbox)
 * must stay out of it.
 */
export const insideOpenDialog = (path: ReadonlyArray<EventTarget>): boolean =>
  path.some(
    (node) =>
      (Predicate.hasProperty(node, "tagName") &&
        node.tagName === "DIALOG" &&
        Predicate.hasProperty(node, "open") &&
        node.open === true) ||
      (Predicate.hasProperty(node, "role") && (node.role === "dialog" || node.role === "alertdialog"))
  )
