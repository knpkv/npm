export const NATIVE_REVIEW_POST_PROCESSING_RESERVE_MILLIS = 30_000

export const MINIMUM_PR_REVIEW_BUDGET_MILLIS = NATIVE_REVIEW_POST_PROCESSING_RESERVE_MILLIS * 2

export const nativeReviewMaximumDurationMillis = (
  budgetMillis: number
): number | null =>
  budgetMillis < MINIMUM_PR_REVIEW_BUDGET_MILLIS
    ? null
    : budgetMillis - NATIVE_REVIEW_POST_PROCESSING_RESERVE_MILLIS
