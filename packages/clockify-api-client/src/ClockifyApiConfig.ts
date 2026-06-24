/**
 * Configuration service tag for the Clockify API client.
 *
 * **Mental model**
 *
 * - **Context.Tag for DI**: {@link ClockifyApiConfig} carries API key (as `Redacted`),
 *   workspace ID, user ID, and base URL. Provided via `Layer.succeed` by the consumer.
 * - **Redacted API key**: The `apiKey` field uses Effect's `Redacted` type to prevent
 *   accidental logging of credentials.
 *
 * @module
 */
import * as Context from "effect/Context"
import type * as Redacted from "effect/Redacted"

export interface ClockifyApiConfigShape {
  readonly apiKey: Redacted.Redacted<string>
  readonly workspaceId: string
  readonly userId: string
  readonly baseUrl: string
}

export class ClockifyApiConfig extends Context.Service<ClockifyApiConfig, ClockifyApiConfigShape>()(
  "@knpkv/clockify-api-client/ClockifyApiConfig"
) {}
