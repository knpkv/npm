# 0006 — Keep Jira writes proposal-only without an atomic revision guard

Status: accepted

## Context

The Control Center requirements bind every remote write to an exact target revision and require a
stale revision to produce no provider mutation. Jira Cloud's documented edit, comment, transition,
and issue-link APIs do not expose a provider-enforced revision condition or `If-Match` contract.
A final read immediately before a write is not atomic and cannot satisfy that invariant.

## Decision

Jira lifecycle drafts remain validated, persisted, and reviewable proposal state. Description,
acceptance-criteria, comment/reply, transition, link/version association, and approval proposals
must all fail closed before provider execution while Jira lacks a documented, verified atomic
revision precondition for the exact target revision. The release journey may claim one governed
action for providers whose enabled operation enforces that capability, but Jira is an explicit
capability-truthful proposal-only exception.

This does not weaken the generic governed-action contract, authorization checks, stale-evidence
handling, or zero-provider-call guarantees. If Jira later documents an atomic revision condition,
its execution capability requires a separate design decision, provider contract tests, and acceptance
evidence before being enabled.

## Evidence

- [SC7.9 and acceptance traceability](../../.specs/control-center/requirements.md) define the
  proposal-only lifecycle and recoverable stale-revision conflict.
- [M5.6 completion journey](../../.specs/control-center/remaining-work.md) records Jira as the
  explicit exception to the per-provider governed-action sentence.
- Issue [#205](https://github.com/knpkv/npm/issues/205) records the provider-contract evidence and
  the existing zero-provider-call regression coverage.
