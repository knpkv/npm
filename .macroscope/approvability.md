---
neverApprove:
  - ".github/workflows/**"
  - ".github/actions/**"
  - ".changeset/config.json"
  - ".macroscope/**"
---

Use Macroscope's default approvability criteria.

In addition, a pull request is not auto-approvable and requires human review when it:

- changes a product default: a default option value, a default setting, configuration or theme, a default
  model, timeout, limit or retry policy, or what a user sees before changing anything;
- adds or broadens a directive or configuration that disables or suppresses a lint, type-checker, LSP or other
  static-analysis diagnostic. This includes file-level, line-level and configuration-level overrides, such as
  `eslint-disable`, `oxlint-disable`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@effect-diagnostics`,
  `ast-grep-ignore`, a rule turned off or narrowed in a lint or ast-grep config, a widened `ignores` or `files`
  list, a raised `docs/debt.baseline.json` count, or an entry added to an allowlist or baseline file;
- touches GitHub workflows or actions under `.github/`;
- changes release or changeset configuration: `.changeset/config.json`, the release workflow, version or
  publish scripts, or the `publishConfig`, `version` or `private` fields of a package manifest;
- removes or renames a package `exports` entry, or removes or incompatibly changes an exported type, function,
  schema or component of a published package;
- touches authentication, authorization, approval, credential or secret-handling code: sign-in and OAuth flows,
  session, pairing and CSRF tokens, permission and approval checks, governed-action approval, and anything that
  reads, stores, redacts or passes provider credentials.
