# 0006 — Keep Jira issue writes proposal-only without an atomic revision guard

Status: accepted

## Context

The Control Center requirements bind every remote write to an exact target revision and require a
stale revision to produce no provider mutation. Jira Cloud's documented edit, comment, transition,
and issue-link APIs do not expose a provider-enforced revision condition or `If-Match` contract.
A final read immediately before a write is not atomic and cannot satisfy that invariant.

## Decision

Jira issue lifecycle drafts remain validated, persisted, and reviewable proposal state. Description,
acceptance-criteria, comment/reply, transition, link/version association, and approval proposals
must all fail closed before provider execution while Jira lacks a documented, verified atomic
revision precondition for the exact target revision.

The separately negotiated `create-release-version` action may create one project-scoped Jira
version after explicit workspace-owner confirmation. This is a create-only release-publication
capability, not a mutation of a synchronized `jira.issue`: its canonical payload persists the
project ID, version name, and description; its identity includes the workspace, connection,
release, source-revision digest, destination, and payload; and its executor checks for an exact
existing name before dispatch, recovers ambiguous outcomes by that name, and reports duplicate
matches as a conflict. It never edits, deletes, or re-associates an existing Jira issue or version.
Because no existing target revision is replaced, the issue-revision precondition in this decision
does not apply to this narrowly bounded creation capability.

This does not weaken the generic governed-action contract, authorization checks, stale-evidence
handling, or zero-provider-call guarantees. If Jira later documents an atomic revision condition,
its execution capability requires a separate design decision, provider contract tests, and acceptance
evidence before being enabled.

## Evidence

- [SC7.9 and acceptance traceability](../../.specs/control-center/requirements.md) define the
  proposal-only lifecycle and recoverable stale-revision conflict.
- [M5.6 completion journey](../../.specs/control-center/remaining-work.md) records the distinction
  between proposal-only Jira issue mutations and governed release-version creation.
- Issue [#205](https://github.com/knpkv/npm/issues/205) records the provider-contract evidence and
  the existing zero-provider-call regression coverage.
