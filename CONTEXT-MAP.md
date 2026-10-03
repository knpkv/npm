# Context Map

## Contexts

- [Jira Markdown](./CONTEXT.md) — represents Jira work items as local Markdown and reconciles changes.
- [Control Center](./packages/control-center/CONTEXT.md) — connects delivery work across followed resources and supports governed human-agent collaboration.
- [Agent Usage](./packages/agent-usage/CONTEXT.md) — records Claude and Codex subscription usage per machine over time, per ticket, and against subscription limits.

## Relationships

- **Control Center → provider packages**: Control Center uses the product packages as adapter boundaries; those packages retain ownership of provider-specific authentication and API behavior.
- **Jira Markdown ↔ Control Center**: Both may read Jira, but Jira Markdown owns local document reconciliation while Control Center owns cross-provider delivery relationships.
- **Agent Usage ↔ Jira Markdown**: Agent Usage reads ticket keys from agent sessions and may look up ticket titles, but owns no Jira state.
