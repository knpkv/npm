/**
 * `confluence auth`: the shared Atlassian auth commands over {@link ConfluenceAuth}.
 */
import { makeAuthCommand } from "@knpkv/atlassian-common/cli-auth"
import { ConfluenceAuth, confluenceCliDescriptor } from "../ConfluenceAuth.js"

export const authCommand = makeAuthCommand(ConfluenceAuth, confluenceCliDescriptor, {
  apiSection: "Confluence API (granular)"
})
