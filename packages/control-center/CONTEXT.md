# Control Center

Control Center connects work, code, delivery, knowledge, time, people, and agents without collapsing the identities of the external systems it integrates.

## Language

**Workspace**:
The collaboration boundary in which people connect provider accounts, follow resources, and inspect delivery state.
_Avoid_: Organization, tenant, project

**Provider Account**:
One external account or site authorized for a Workspace, such as an AWS account or Atlassian site. A Provider Account may own many Followed Resources.
_Avoid_: Service connection, repository connection, plugin

**Local Credential Profile**:
A machine-local selector used to authenticate a Provider Account without becoming part of shareable Workspace data.
_Avoid_: Provider account, connection, credentials record

**Followed Resource**:
A provider-owned resource selected for observation within a Provider Account, such as a repository, pipeline, Jira project, or Confluence space.
_Avoid_: Account, service, plugin

**Plugin Connection**:
The executable adapter binding that synchronizes one Followed Resource into a Workspace. Multiple Plugin Connections may share one Provider Account.
_Avoid_: Provider account, credential profile

**Delivery Relationship**:
An evidence-backed association between normalized work, code, release, deployment, knowledge, or time entities.
_Avoid_: Name match, UI link

**Release Workset**:
The Jira items selected for one release together with their pull-request and pipeline dimensions.
_Avoid_: Ticket list, sprint board
