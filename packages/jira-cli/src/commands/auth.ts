/**
 * `jira auth`: the shared Atlassian auth commands over {@link JiraAuth}.
 *
 * @internal
 */
import { makeAuthCommand } from "@knpkv/atlassian-common/cli-auth"
import { JiraAuth, jiraCliDescriptor } from "../JiraAuth.js"

export const authCommand = makeAuthCommand(JiraAuth, jiraCliDescriptor, { apiSection: "Jira API" })
