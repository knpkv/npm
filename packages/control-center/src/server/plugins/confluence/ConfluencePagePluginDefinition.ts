/** Negotiated definition for the read-only Confluence page adapter. @module */

import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import { definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import { acquireConfluencePageAdapter, ConfluencePageAdapterConfiguration } from "./ConfluencePageAdapter.js"

/** Stable descriptor advertised by the first production Confluence slice. */
export const confluencePagePluginDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.confluence",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Confluence Cloud",
  configurationFields: [
    {
      _tag: "url",
      key: "siteBaseUrl",
      label: "Site URL",
      description: "HTTPS base URL of the Confluence Cloud site.",
      required: true
    },
    {
      _tag: "text",
      key: "siteId",
      label: "Site ID",
      description: "Stable Atlassian site identity used for connection isolation.",
      required: true
    },
    {
      _tag: "text",
      key: "spaceId",
      label: "Space ID",
      description: "Confluence space visible through this connection.",
      required: true
    },
    {
      _tag: "text",
      key: "probePageId",
      label: "Health page ID",
      description: "Readable page used for a bounded connection health check.",
      required: true
    }
  ],
  capabilities: [{
    capabilityId: "entity.read",
    supportedVersions: [1],
    requirement: "required"
  }]
} satisfies unknown

/**
 * Definition consumed by a scoped runtime registry after it supplies an
 * authenticated API client and the owning package's ADF converter.
 */
export const confluencePagePluginDefinition: PluginDefinitionV1 = definePluginV1({
  rawDescriptor: confluencePagePluginDescriptor,
  configurationSchema: ConfluencePageAdapterConfiguration,
  capabilityCodecs: {
    entityRead: pluginCapabilityCodecsV1.entityRead
  },
  make: ({ configuration, descriptor }) => acquireConfluencePageAdapter(configuration, descriptor)
})
