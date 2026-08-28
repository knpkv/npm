import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { CodeCommitPullRequestCandidate, CodeCommitPullRequestResolution } from "../../api/deliveryGraph.js"

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
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.resolveCodeCommitPullRequest({ query: locator })
      }).pipe(
        // This promise bridge owns the browser HTTP client boundary.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(FetchHttpClient.layer)
      ),
      { signal }
    )
}
