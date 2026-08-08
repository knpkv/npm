# Control Center future improvements

This file records deliberate follow-up work that is outside the current narrow delivery slices.

## Provider accounts

- Extend followed-resource selection beyond the current setup forms. Successful AWS and Atlassian setup now reuse the discovered provider account and transactionally bind each executable connection to its discovered repository, pipeline, immutable Jira project, or Confluence space. Provider-backed pickers and pagination should eventually replace manual immutable-ID entry.
- Move setup and listing APIs onto provider accounts so local credential profiles remain machine-local authentication selectors rather than persisted account identity.
- Make multi-resource setup atomic. The browser now submits one bounded server batch and receives ordered per-resource results, but the server deliberately commits each connection independently. An unavailable later resource can therefore leave earlier healthy resources connected and visible; a future unit-of-work boundary should either commit all selected resources together or roll back the batch.
- Add account-level editing so profile or region changes can be validated once and applied safely to every followed resource.

## Atlassian authorization

- Move the inline first-run OAuth app form into a dedicated owner settings view with an explicit credential-rotation flow. Control Center already stores first-run client credentials in its own machine-local auth store and does not require the Jira or Confluence CLI.
- Add revocation, reauthorization, and expired-profile recovery controls without exposing access or refresh tokens.
- Resolve richer provider-owned Jira project and Confluence space metadata, including avatars and canonical browser links, beyond the names already returned during verification.

## Build performance

- Profile and reduce the forced declaration build and distribution validation stages; these currently dominate the apparent pause after the Vite bundles finish.

## Relationship inference

- Replace bounded workspace-wide reconciliation with incremental recomputation from the entities and releases affected by each committed synchronization page. The MVP deliberately skips inference when its complete bounded snapshot cannot be proven.
- Extract explicit Jira and release links from bounded Confluence page bodies when lazy content is materialized. The MVP understands normalized link metadata and falls back to bounded page-title metadata during space synchronization.
- Model multi-source releases explicitly instead of deriving the release graph-node identity from the first synchronized source revision. The MVP-created Jira releases have one authoritative source revision.

## Pull-request review threads

- Virtualize very long browser review threads after several explicitly loaded backward pages. The current browser keeps prior history visible across pull-request heads and temporary launch ineligibility, but intentionally renders the expanded in-memory history without virtualization.

## Review-suggestion revisions

- Sequence the remaining agentic review work as durable task identities and one private lifecycle fold first, then targeted edit/revalidation execution, recovery and retention convergence, and only then the broader agentic review release gate. Do not duplicate lifecycle transitions across dispatch and reconciliation adapters.
- Add a browser-backed edit/conflict/history/publication journey and Storybook state matrix, including keyboard focus and reduced-motion coverage. The MVP has focused component coverage, but not a Playwright journey for this surface; the browser now exposes the durable targeted controls.
- The durable `suggestion-edit` and `suggestion-revalidation` task intents beneath the existing `pr-review` worker route are implemented. The task—not prompt text—binds the source job, stable suggestion, selected revision, and exact immutable head.
- Give targeted `sbx` runs the selected revision plus its complete bounded immutable history. Split structured output into edit, validated revalidation, and unable-to-conclude protocols; decode and re-anchor all output on the host.
- Fold a successful targeted result and the terminal job transition through one durable repository transaction. Agent edits must append `requires-revalidation`; successful revalidation must append a new `validated` revision. Failed, cancelled, inconclusive, or superseded runs append no revision.
- Keep **Ask agent to edit** and **Revalidate** bound to the durable targeted protocol. Do not regress either control into a free-form full-review prompt, because prompt text is not an authority boundary.
- Add the opt-in real Codex-through-`sbx` targeted edit/revalidation smoke fixture. Assert exact-head provenance, file exploration and test execution, structured revision output, and absence of push, comment, approval, database, credential, and network authority.
