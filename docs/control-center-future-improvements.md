# Control Center future improvements

This file records deliberate follow-up work that is outside the current narrow delivery slices.

## Provider accounts

- Extend followed-resource selection beyond the current setup forms. Successful AWS and Atlassian setup now reuse the discovered provider account and transactionally bind each executable connection to its discovered repository, pipeline, immutable Jira project, or Confluence space. Provider-backed pickers and pagination should eventually replace manual immutable-ID entry.
- Move setup and listing APIs onto provider accounts so local credential profiles remain machine-local authentication selectors rather than persisted account identity.
- Make multi-resource setup atomic. The browser now submits one bounded server batch and receives ordered per-resource results, but the server deliberately commits each connection independently. An unavailable later resource can therefore leave earlier healthy resources connected and visible; a future unit-of-work boundary should either commit all selected resources together or roll back the batch.
- Add account-level editing so profile or region changes can be validated once and applied safely to every followed resource.

## Atlassian authorization

- Move OAuth client registration into a dedicated owner settings view. The MVP reports the callback URL and reuses the secure CLI client configuration files rather than accepting a client secret in browser state.
- Add revocation, reauthorization, and expired-profile recovery controls without exposing access or refresh tokens.
- Resolve richer provider-owned Jira project and Confluence space metadata, including avatars and canonical browser links, beyond the names already returned during verification.

## Build performance

- Profile and reduce the forced declaration build and distribution validation stages; these currently dominate the apparent pause after the Vite bundles finish.
- Cache or avoid unchanged dependency builds in local end-to-end workflows.
