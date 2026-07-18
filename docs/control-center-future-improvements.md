# Control Center future improvements

This file records deliberate follow-up work that is outside the current narrow delivery slices.

## Provider accounts

- Persist a first-class provider-account record and explicit followed-resource records. The current AWS setup reuses the production adapter contract by creating one connection per repository or pipeline with the same local profile and region.
- Make multi-resource setup atomic. Today resources are connected sequentially, so an unavailable later resource can leave earlier healthy resources connected and visible.
- Add account-level editing so profile or region changes can be applied safely to every followed resource.

## Atlassian authorization

- Prefer a shared browser OAuth grant for Jira and Confluence, with API tokens retained as a deliberate compatibility fallback.
- Persist the selected Atlassian site separately from followed Jira projects and Confluence spaces.

## Build performance

- Profile and reduce the forced declaration build and distribution validation stages; these currently dominate the apparent pause after the Vite bundles finish.
- Cache or avoid unchanged dependency builds in local end-to-end workflows.
