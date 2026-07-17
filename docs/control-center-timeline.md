# Control Center Timeline

The Timeline is the workspace bird's-eye activity view. It is not a Jira-style
ticket feed: it combines attributable changes from people, local agents,
connected services, and Control Center itself into one compact chronology.

## Current MVP

- Durable sources: governed-action audit events, plugin sync commits,
  relationship revisions, and domain events.
- Bounded reads: each source receives the same workspace, actor, UTC date,
  stable cursor, and page-size constraints before execution.
- Stable merge: `occurredAt DESC, eventKey DESC`, followed by one page cap.
- Default-redacted output: human-readable actor labels and safe application links;
  raw actor IDs, job IDs, action IDs, and relationship IDs are not exposed.
- Provider marks: plugin sync activity retains its validated CodeCommit,
  CodePipeline, Jira, Confluence, or Clockify identity.
- Access: workspace owners and approvers can read; watchers are rejected. A
  deliberate exact-event detail request is owner-only and returns the stored
  actor, action, relationship, connection, release, entity, and agent-job
  identifiers while ordinary pages remain redacted.
- Downloads: authenticated CSV and JSON endpoints require an explicit event cap,
  accept the same actor and UTC date filters, page through the stable Timeline
  cursor, and stop at 1,000 default-redacted events. Responses are private,
  non-sniffable attachments; JSON and response headers report truncation. Each
  successfully collected download records an immutable workspace, human,
  session, format, filters, requested limit, returned count, truncation, and
  timestamp audit before streaming starts.
- UI: large source totals, actor/date filters, incremental paging, deep links, and
  a Timeline-aware Relay entry.

The query builder remains private to `@knpkv/control-center-sql`. The application
repository receives rendered SQL plus bound parameters and Schema-decodes every
database row before it enters the domain projection.

## Deferred improvements

These are intentionally outside this fast MVP and remain follow-up work:

- export-artifact retention policy; the bounded MVP streams the response directly
  and persists attribution, not the downloaded artifact;
- provider provenance for action, relationship, and system rows when their source
  connection is indirect or absent;
- a denormalized Timeline projection if measured source-query latency eventually
  justifies one; Effect Persistence is not the relational foundation for it;
- live insertion from the resumable event stream while preserving scroll position;
- richer source-specific event summaries and release/entity context chips;
- dedicated browser interaction and visual-regression coverage for filters,
  incremental paging, narrow layouts, and empty/error states.

No migrations are added while the schema is unstable. If a future denormalized
projection changes storage, update the exact schema snapshot and recreate local
development data. Start versioned migrations only after a released database must
remain readable by a newer build.
