import { FleetOperationError, FleetValidationError, type HostConfiguration } from "@knpkv/herdr-fleet"
import { nodeIpv4, resolveFleetNode, type TailscaleClient } from "@knpkv/herdr-tailscale"
import { Effect } from "effect"

export const resolveApprovalPage = Effect.fn("Fleetctl.resolveApprovalPage")(function*(
  config: HostConfiguration,
  tailscale: TailscaleClient,
  target: string
) {
  if (!config.crossHost) {
    return yield* new FleetValidationError({
      detail: "cross-host approval is disabled on this machine"
    })
  }
  const known = config.machines.find(
    ({ host }) => host.toLowerCase() === target.toLowerCase()
  )
  if (known === undefined) {
    return yield* new FleetValidationError({ detail: `unknown host: ${target}` })
  }
  if (known.host.toLowerCase() === config.approvalHub.host.toLowerCase()) {
    return config.approvalHub.url
  }
  const status = yield* tailscale.status.pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          cause,
          detail: String(cause),
          operation: "tailscale.status"
        })
    )
  )
  const node = yield* resolveFleetNode(status, known).pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          cause,
          detail: String(cause),
          operation: "fleet.resolve_approval_page.identity"
        })
    )
  )
  const address = nodeIpv4(node)
  if (address === undefined || !node.Online) {
    return yield* new FleetOperationError({
      cause: known.host,
      detail: `${known.host} is not online in Tailscale status`,
      operation: "fleet.resolve_approval_page"
    })
  }
  return `http://${address}:${config.approvalPort}/`
})
