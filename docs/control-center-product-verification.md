# Control Center product verification

This checklist is the release gate for Relay’s cross-provider user paths.

## Criteria and current status

| Criterion                                                                                                           | Status | Evidence                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Relay opens from arbitrary Control Center pages with exact workspace, release, entity, and return-path context.     | Pass   | Safari evidence below; browser coverage exercises contextual entry and return paths.                         |
| Relay answers from the admitted release projection, never demo or neighboring release data.                         | Pass   | Release-agent application and handler suites bind every turn to one release snapshot.                        |
| CodeCommit pull-request details load the complete bounded diff with exact base/head identity.                       | Pass   | Safari PR #44 evidence below and CodeCommit adapter/browser suites.                                          |
| CodeCommit review remains human-confirmed and fails closed without a connected release.                             | Pass   | Governed review tests and browser verification.                                                              |
| Release chat may suggest Jira or Confluence publication but cannot perform the external write.                      | Pass   | The chat handler is read-only; publication uses the dedicated owner-confirmed endpoint.                      |
| Owner-confirmed Jira publication creates or exactly confirms the canonical release version.                         | Pass   | Jira governed-action and integration suites; succeeded action evidence below.                                |
| Owner-confirmed Confluence publication creates or updates the exact release page.                                   | Pass   | Confluence governed-action and integration suites; succeeded action evidence below.                          |
| Existing Jira versions are confirmed only when name and release notes exactly match; ambiguity or mismatches block. | Pass   | Jira executor preflight, recovery, and reconciliation compare the complete authorized payload.               |
| Informational or imperative chat text does not create governed actions.                                             | Pass   | Server handler regression asserts zero publication submissions from release chat.                            |
| Jira issue edits remain proposal-only.                                                                              | Pass   | Runtime capability and governed-action tests.                                                                |
| Standalone Atlassian reauthorization requests only its product; a proven shared account requests both products.     | Pass   | Services component tests cover Jira-only and shared-account intent.                                          |
| Publication identity includes the exact release source digest and configured destination.                           | Pass   | Canonical identity and execution-authority checks reject changed release baselines before provider dispatch. |

## Browser evidence

Safari MCP verification on 2026-08-02 used the signed-in Control Center and Jira sessions:

- Relay showed `EXACT CONTEXT` for `npm / Control Center E2E 2026-07-26 / Quiet Spark`.
- CodeCommit pull request #44 rendered one indexed `fixture.txt` diff and reached `Ready`.
- Confluence publication succeeded as action `019fc436-428e-7279-b027-e2aa4a05dd5d`.
- Jira publication returned succeeded action `019fc44b-5151-7198-ad5b-1dafdb80bc29`; Jira Releases showed `Control Center E2E 2026-07-26`.
- The informational Confluence question left the governed-action count unchanged at 7.

## Automated gates

- Pull-request Audit, Browser, Format, Lint, Snapshot, Test, Types, Jira integration, and Confluence integration gates passed on the reviewed head.
- Focused release-publication, portfolio, Services, agent-page, Jira, persistence, and API handler suites pass locally.
- Local macOS persistence suites that create temporary roots still hit the known canonical-path fixture failure (`BlobContainmentError`); the equivalent Linux pull-request Test gate is authoritative and passes.
