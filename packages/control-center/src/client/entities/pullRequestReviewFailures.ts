import * as Predicate from "effect/Predicate"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

/** Whether a review snapshot read can be retried without operator intervention. */
export const isRecoverablePullRequestReviewFailure = (failure: unknown): boolean =>
  Predicate.isTagged(failure, "RequestTimedOutApiError") ||
  Predicate.isTagged(failure, "RateLimitedApiError") ||
  Predicate.isTagged(failure, "ServiceUnavailableApiError") ||
  (
    HttpClientError.isHttpClientError(failure) &&
    failure.reason._tag === "TransportError"
  )

/** Whether an authenticated review request proves that the browser session expired. */
export const isUnauthorizedPullRequestReviewFailure = (failure: unknown): boolean =>
  Predicate.isTagged(failure, "UnauthorizedApiError")
