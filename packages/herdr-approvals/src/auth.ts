import { FleetAuthorizationError } from "@knpkv/herdr-fleet"
import { Effect } from "effect"

export interface RequestIdentity {
  readonly login: string | undefined
  readonly remoteAddress: string | undefined
}

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export const authorize = (
  identity: RequestIdentity,
  allowedUsers: ReadonlyArray<string>,
  allowLocal: boolean
) =>
  allowLocal && loopback.has(identity.remoteAddress ?? "") && identity.login === undefined
    ? Effect.succeed("local")
    : Effect.fail(
      new FleetAuthorizationError({
        actor: identity.login ?? identity.remoteAddress ?? "unknown"
      })
    )
