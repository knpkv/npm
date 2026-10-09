import {
  PullRequestConversationAmbiguous,
  type PullRequestConversationLocator,
  PullRequestConversationLookupFailed,
  PullRequestConversationNotFound,
  PullRequestConversationRedirectFailed,
  RelayAuthenticationRequired,
  RelayAuthorizationDenied,
  type RelayProductDockHost,
  RelayProductPanel
} from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ReactElement, useMemo } from "react"
import { useLocation, useNavigate } from "react-router"

import * as CodeCommitDomain from "@knpkv/codecommit-core/Domain.js"
import { useBrowserSession } from "./BrowserSession.js"
import { contextualAgentPath } from "./contextualAgentPath.js"
import {
  controlCenterRelayCandidatesForAccount,
  controlCenterRelayHostSelection,
  selectControlCenterRelayCandidate
} from "./controlCenterRelayDock.js"
import { workspaceEntityPath } from "./workspaceEntityPaths.js"

/**
 * Relay's panel for Control Center, rendered right after the header launcher: a registered PR opens
 * into its thread; elsewhere the panel offers the page's release conversation (or Relay's full page),
 * which keeps its own route, durable key and origin, then the authenticated PR locator. The PR and
 * entity pages are not measured beside a pinned column yet, so the pin is unavailable.
 */
export const ControlCenterRelayPanel = (): ReactElement => {
  const browserSession = useBrowserSession()
  const navigate = useNavigate()
  const location = useLocation()
  const agentPath = contextualAgentPath(location.pathname, location.search, location.hash)
  const host = useMemo<RelayProductDockHost>(
    () => ({
      alternate: {
        label: agentPath.startsWith("/agent?") ? "Open Relay's full page" : "Open the release conversation, full page",
        onOpen: () => void navigate(agentPath, { state: location.state })
      },
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
          const matches = controlCenterRelayCandidatesForAccount(resolution, locator.accountId)
          if (locator.accountId !== undefined && matches.length === 0) {
            return yield* new PullRequestConversationNotFound({
              product: "control-center",
              pullRequestId: locator.pullRequestId,
              repositoryName: locator.repositoryName
            })
          }
          return yield* new PullRequestConversationAmbiguous({
            matches: matches.length,
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
    [agentPath, browserSession.state, location.state, navigate]
  )
  return <RelayProductPanel host={host} pin={{ _tag: "Unavailable" }} />
}
