# Context Map

## Contexts

- [Jira Markdown](./CONTEXT.md) — represents Jira work items as local Markdown and reconciles changes.
- [Control Center](./packages/control-center/CONTEXT.md) — connects provider accounts and followed delivery resources into one operational view.

## Relationships

- **Control Center → provider packages**: Control Center uses the product packages as adapter boundaries; those packages retain ownership of provider-specific authentication and API behavior.
- **Jira Markdown ↔ Control Center**: Both may read Jira, but Jira Markdown owns local document reconciliation while Control Center owns cross-provider delivery relationships.
