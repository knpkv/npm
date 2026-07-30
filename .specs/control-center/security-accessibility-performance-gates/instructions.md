# Control Center security, accessibility, and performance gates

Implement issue #216 as a thin release-gate slice on top of the completed Control Center MVP.

## Working rules

- Preserve the existing SecretStore, provider, typed-error, workspace-authorization, schema, and migration boundaries.
- Prefer browser-backed acceptance coverage and durable benchmark evidence over production rewrites.
- Exercise production routes and the real packaged runtime; component-only evidence is insufficient.
- Keep every benchmark correctness cap and cardinality assertion. Timing assertions may be added, but correctness bounds must not be weakened or skipped on slower machines.
- Reuse the documented large deterministic fixture and the repository-managed runtime lifecycle.
- Treat the trusted HTTPS proxy path as the second-machine deployment contract. The browser must enter through HTTPS while the immediate application peer is an explicitly trusted loopback proxy.
- Test secrets and certificates must be unmistakably non-production fixtures and must not enter logs, HTML, URLs, browser storage, or reports.
- Add the smallest durable guardrail for each confirmed gap, then run focused checks before the complete repository gate.
- Do not change the SQLite schema or add a migration.

## Delivery

- Produce one independently reviewable pull request.
- Require format, lint, type, unit, browser, benchmark, and exact-head review success.
- Resolve all review feedback at the exact pull-request head before merge.
