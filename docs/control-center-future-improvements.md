# Control Center future improvements

This file records deliberate follow-up work that is outside the current narrow delivery slices.

## Provider accounts

- Bind plugin connections to the new first-class provider-account and followed-resource records. Persistence now represents one AWS account with many repositories and pipelines, but onboarding still creates one independent plugin connection per resource.
- Move setup and listing APIs onto provider accounts so local credential profiles remain machine-local authentication selectors rather than persisted account identity.
- Make multi-resource setup atomic. Today resources are connected sequentially, so an unavailable later resource can leave earlier healthy resources connected and visible.
- Add account-level editing so profile or region changes can be validated once and applied safely to every followed resource.

## Atlassian authorization

- Add an in-app browser OAuth grant and callback. The current OAuth-first setup safely reuses local `jira-cli` and `confluence-to-markdown` profiles, with API tokens retained as a deliberate compatibility fallback.
- Persist the selected Atlassian site separately from followed Jira projects and Confluence spaces.

## Build performance

- Profile and reduce the forced declaration build and distribution validation stages; these currently dominate the apparent pause after the Vite bundles finish.
- Cache or avoid unchanged dependency builds in local end-to-end workflows.
