import type { HostConfiguration } from "@knpkv/herdr-fleet/model"

type HubIdentity = Pick<HostConfiguration, "host" | "approvalHub" | "allowedUsers">

/** A viewer on the hub machine is the hub's own tailnet node calling this hub. */
export const onHubNode = (config: HubIdentity, nodeId: string): boolean =>
  config.host.toLowerCase() === config.approvalHub.host.toLowerCase() && nodeId === config.approvalHub.nodeId

/**
 * The module caller for a WhoIs-authorized tailnet request. `sameNode` comes only from its node; `owner`
 * is the hub's own node, or an allowed login from any node. Approvals stay limited to approval nodes.
 */
export const moduleCallerFor = (
  config: HubIdentity,
  identity: { readonly login: string; readonly nodeId: string }
) => {
  const sameNode = onHubNode(config, identity.nodeId)
  return { login: identity.login, sameNode, owner: sameNode || config.allowedUsers.includes(identity.login) }
}
