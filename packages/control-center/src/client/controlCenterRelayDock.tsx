import * as CodeCommitDomain from "@knpkv/codecommit-core/Domain.js"
import {
  PullRequestConversation,
  PullRequestConversationAmbiguous,
  type PullRequestConversationLocator,
  PullRequestConversationLookupFailed,
  PullRequestConversationNotFound,
  PullRequestConversationRedirectFailed,
  RelayAuthenticationRequired,
  RelayAuthorizationDenied,
  RelayProductDock,
  type RelayProductDockHost,
  RelayProductDockInvariantViolation,
  RelaySelectorState
} from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type ReactElement, type ReactNode, useMemo } from "react"
import { useNavigate } from "react-router"

import { useBrowserSession } from "./BrowserSession.js"
import type { OpenPullRequestCandidate, OpenPullRequestResolution } from "./openPullRequest/openPullRequest.js"
import { workspaceEntityPath } from "./workspaceEntityPaths.js"

/** Enforce an optional browser-safe account label for every resolver outcome. */
const candidateMatchesAccount = (candidate: OpenPullRequestCandidate, accountId: string): boolean =>
  candidate.accountLabel === accountId || candidate.accountLabel.endsWith(` · AWS ${accountId}`)

export const selectControlCenterRelayCandidate = (
  resolution: OpenPullRequestResolution,
  accountId: string | undefined
): OpenPullRequestCandidate | undefined => {
  switch (resolution._tag) {
    case "found":
      return accountId === undefined || candidateMatchesAccount(resolution.candidate, accountId)
        ? resolution.candidate
        : undefined
    case "ambiguous": {
      if (accountId === undefined) return undefined
      const matches = resolution.candidates.filter((candidate) => candidateMatchesAccount(candidate, accountId))
      return matches.length === 1 ? matches[0] : undefined
    }
    case "account-identity-unavailable":
    case "not-found":
      return undefined
  }
}

export const decodeControlCenterRelaySelector = (input: typeof RelaySelectorState.Encoded): RelaySelectorState => {
  const decoded = Schema.decodeUnknownResult(RelaySelectorState)(input)
  if (Result.isFailure(decoded)) throw new RelayProductDockInvariantViolation({ boundary: "selector" })
  return decoded.success
}

export const decodeControlCenterRelayConversation = (
  input: typeof PullRequestConversation.Encoded
): PullRequestConversation => {
  const decoded = Schema.decodeUnknownResult(PullRequestConversation)(input)
  if (Result.isFailure(decoded)) throw new RelayProductDockInvariantViolation({ boundary: "conversation" })
  return decoded.success
}

export const controlCenterRelayHostSelection = decodeControlCenterRelaySelector({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "read-only-review",
  profiles: [{ id: "read-only-review", label: "Read-only PR review" }]
})

/** Install Control Center's authenticated workspace resolver behind the shared Relay dock. */
export const ControlCenterRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const browserSession = useBrowserSession()
  const navigate = useNavigate()
  const host = useMemo<RelayProductDockHost>(
    () => ({
      context: [{ id: "product", label: "Product", value: "Control Center" }],
      locatePullRequestConversation: Effect.fn("ControlCenterRelayDock.locatePullRequestConversation")(function* (
        locator: PullRequestConversationLocator
      ) {
        if (browserSession.state._tag !== "authenticated") {
          return yield* new RelayAuthenticationRequired({
            operation: "locate-pull-request-conversation",
            product: "control-center"
          })
        }
        const session = browserSession.state.session
        if (session.permission !== "workspace-owner" && session.permission !== "workspace-approver") {
          return yield* new RelayAuthorizationDenied({
            operation: "locate-pull-request-conversation",
            product: "control-center"
          })
        }
        const providerLocator = yield* Schema.decodeUnknownEffect(CodeCommitDomain.CodeCommitPullRequestLocator)({
          pullRequestId: locator.pullRequestId,
          region: locator.region,
          repositoryName: locator.repositoryName
        }).pipe(
          Effect.mapError(
            (): PullRequestConversationLookupFailed =>
              new PullRequestConversationLookupFailed({ product: "control-center" })
          )
        )
        const openPullRequest = yield* Effect.tryPromise({
          try: () => import("./openPullRequest/openPullRequest.js"),
          catch: (): PullRequestConversationLookupFailed =>
            new PullRequestConversationLookupFailed({ product: "control-center" })
        })
        const resolution = yield* Effect.tryPromise({
          try: (signal) => openPullRequest.browserOpenPullRequestTransport.resolve(providerLocator, signal),
          catch: (): PullRequestConversationLookupFailed =>
            new PullRequestConversationLookupFailed({ product: "control-center" })
        })
        const candidate = selectControlCenterRelayCandidate(resolution, locator.accountId)
        if (candidate !== undefined) {
          const href = workspaceEntityPath(session.workspaceId, candidate.entityId)
          return yield* Effect.tryPromise({
            try: async () => {
              await navigate(href)
            },
            catch: (): PullRequestConversationRedirectFailed =>
              new PullRequestConversationRedirectFailed({ href, product: "control-center" })
          })
        }
        if (resolution._tag === "ambiguous") {
          return yield* new PullRequestConversationAmbiguous({
            matches: resolution.candidates.length,
            product: "control-center",
            pullRequestId: locator.pullRequestId,
            repositoryName: locator.repositoryName
          })
        }
        if (resolution._tag === "account-identity-unavailable") {
          return yield* new PullRequestConversationLookupFailed({ product: "control-center" })
        }
        return yield* new PullRequestConversationNotFound({
          product: "control-center",
          pullRequestId: locator.pullRequestId,
          repositoryName: locator.repositoryName
        })
      }),
      product: "control-center",
      selection: controlCenterRelayHostSelection
    }),
    [browserSession.state, navigate]
  )
  return <RelayProductDock host={host}>{children}</RelayProductDock>
}
