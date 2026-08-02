# Control Center product verification

This checklist is the release gate for Relay’s cross-provider user paths.

## Criteria

- Relay can be opened from an arbitrary Control Center page and keeps the exact workspace, release, entity, and return-path context.
- Relay answers from the exact release projection, never from demo or neighboring release data.
- CodeCommit pull-request details load through the complete bounded diff, including indexed file content and exact base/head identity.
- CodeCommit review remains human-confirmed and fails closed when the pull request is not connected to a release.
- An explicit natural-language Jira publication request creates or confirms the canonical release version through a governed action and reports its durable action receipt.
- An explicit natural-language Confluence publication request creates a release page through a governed action and reports its durable action receipt.
- Existing Jira versions are idempotently confirmed when exactly one canonical match exists; ambiguous duplicates remain blocked.
- Informational questions such as “How do I create a Confluence page?” do not create governed actions.
- Jira issue edits remain proposal-only.
- Reauthorizing the shared Atlassian connection requests both Jira and Confluence scopes, including write-capable Jira release-version scopes.

## Browser evidence

Safari MCP verification on 2026-08-02 used the signed-in Control Center and Jira sessions:

- Relay showed `EXACT CONTEXT` for `npm / Control Center E2E 2026-07-26 / Quiet Spark`.
- CodeCommit pull request #44 rendered one indexed `fixture.txt` diff and reached `Ready`.
- Confluence publication succeeded as action `019fc436-428e-7279-b027-e2aa4a05dd5d`.
- Jira publication returned succeeded action `019fc44b-5151-7198-ad5b-1dafdb80bc29`; Jira Releases showed `Control Center E2E 2026-07-26`.
- The informational Confluence question left the governed-action count unchanged at 7.

## Automated gates

- Focused Control Center tests: 164 passed.
- Control Center type-check, lint, and production build: passed.
- The full Control Center suite currently cannot be used as a code gate in this workspace: 1,873 passed and 392 failed because temporary test roots resolve through symlinked paths, triggering `BlobContainmentError`, `SecretProtectionError`, and private-directory validation failures. The failure is environmental and affects unrelated persistence/runtime suites.
