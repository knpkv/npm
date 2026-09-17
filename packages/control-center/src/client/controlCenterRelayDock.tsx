import { PullRequestConversation } from "@knpkv/relay-product/conversation"
import { RelayProductDockInvariantViolation } from "@knpkv/relay-product"
import { RelaySelectorState } from "@knpkv/relay-product/model"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { OpenPullRequestCandidate, OpenPullRequestResolution } from "./openPullRequest/openPullRequest.js"

/** Enforce an optional browser-safe account label for every resolver outcome. */
const candidateMatchesAccount = (candidate: OpenPullRequestCandidate, accountId: string): boolean =>
  candidate.accountLabel === accountId || candidate.accountLabel.endsWith(` · AWS ${accountId}`)

/** Apply the host account constraint before classifying a locator result. */
export const controlCenterRelayCandidatesForAccount = (
  resolution: OpenPullRequestResolution,
  accountId: string | undefined
): ReadonlyArray<OpenPullRequestCandidate> => {
  switch (resolution._tag) {
    case "found":
      return accountId === undefined || candidateMatchesAccount(resolution.candidate, accountId)
        ? [resolution.candidate]
        : []
    case "ambiguous":
      return accountId === undefined
        ? resolution.candidates
        : resolution.candidates.filter((candidate) => candidateMatchesAccount(candidate, accountId))
    case "account-identity-unavailable":
    case "not-found":
      return []
  }
}

export const selectControlCenterRelayCandidate = (
  resolution: OpenPullRequestResolution,
  accountId: string | undefined
): OpenPullRequestCandidate | undefined => {
  const matches = controlCenterRelayCandidatesForAccount(resolution, accountId)
  return matches.length === 1 ? matches[0] : undefined
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
