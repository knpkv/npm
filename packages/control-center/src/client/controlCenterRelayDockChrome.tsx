import {
  PullRequestConversationAmbiguous,
  type PullRequestConversationLocator,
  PullRequestConversationLookupFailed,
  PullRequestConversationNotFound,
  PullRequestConversationRedirectFailed,
  RelayAuthenticationRequired,
  RelayAuthorizationDenied,
  RelayProductDockChrome,
  type RelayProductDockHost
} from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ReactElement, useMemo } from "react"
import { useNavigate } from "react-router"

import * as CodeCommitDomain from "@knpkv/codecommit-core/Domain.js"
import { useBrowserSession } from "./BrowserSession.js"
import { controlCenterRelayHostSelection, selectControlCenterRelayCandidate } from "./controlCenterRelayDock.js"
import { workspaceEntityPath } from "./workspaceEntityPaths.js"

/** Install Control Center's authenticated resolver behind the shared Relay chrome. */
export const ControlCenterRelayDockChrome = (): ReactElement => {
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
  return <RelayProductDockChrome host={host} />
}
