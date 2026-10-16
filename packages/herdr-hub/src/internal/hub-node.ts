import type { HostConfiguration } from "@knpkv/herdr-fleet/model"

type HubIdentity = Pick<HostConfiguration, "host" | "approvalHub">

/** A viewer on the hub machine is the hub's own tailnet node calling this hub. */
export const onHubNode = (config: HubIdentity, nodeId: string): boolean =>
  config.host.toLowerCase() === config.approvalHub.host.toLowerCase() && nodeId === config.approvalHub.nodeId

/** The module caller for a WhoIs-authorized tailnet request; `sameNode` comes only from its node. */
export const moduleCallerFor = (
  config: HubIdentity,
  identity: { readonly login: string; readonly nodeId: string }
) => ({ login: identity.login, sameNode: onHubNode(config, identity.nodeId) })
