import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import type { CodeCommitPullRequestCandidate, CodeCommitPullRequestResolution } from "../../api/deliveryGraph.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

export type OpenPullRequestCandidate = CodeCommitPullRequestCandidate
export type OpenPullRequestResolution = CodeCommitPullRequestResolution

export interface OpenPullRequestTransport {
  readonly resolve: (
    locator: Domain.CodeCommitPullRequestLocator,
    signal: AbortSignal
  ) => Promise<OpenPullRequestResolution>
}

/** One authenticated batch request; the server owns bounded matching and account labeling. */
export const browserOpenPullRequestTransport: OpenPullRequestTransport = {
  resolve: (locator, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.deliveryGraph.resolveCodeCommitPullRequest({ payload: locator })
      }).pipe(
        // This promise bridge owns the browser HTTP client boundary.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(FetchHttpClient.layer)
      ),
      { signal }
    )
}
