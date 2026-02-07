/**
 * @internal
 */
import type { SubscriptionRef } from "effect"
import type { AppState } from "../Domain.js"

export type PRState = SubscriptionRef.SubscriptionRef<AppState>
