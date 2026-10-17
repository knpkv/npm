---
title: Effect Conventions
input: incremental
tools:
  - browse_code
  - git_tools
  - modify_pr
include:
  - "packages/*/src/**/*.ts"
  - "packages/*/src/**/*.tsx"
  - "packages/*/scripts/**/*.ts"
exclude:
  - "**/generated/**"
  - "**/vendor/**"
  - "**/*.d.ts"
maxBudgetPerRun: 3
maxBudgetPerPR: 15
conclusion: neutral
---

# Effect conventions review

Review changed TypeScript against the review conventions in `docs/effect-idiom-refactor.md`, included below.
Authors read the same file; the rules live only there, so change them there.

@/docs/effect-idiom-refactor.md

Apply the "Review conventions" section to the lines the pull request changed. The rest of the file is background.
Older code in the same file that predates these conventions is not a finding, and do not ask for
repository-wide cleanup. Skip anything the repository's static checks already report: ast-grep rules in
`ast-grep/rules`, ESLint local rules in `eslint-local-rules.cjs`, oxlint and the Effect language-service
diagnostics run in CI, listed in `docs/effect-static-checks.md`. This check covers what those rules cannot decide.

## Reporting

Report only violations introduced by changed lines. Post each as one inline comment on the smallest relevant
range: name the rule, say what the code should do instead, and stop. Do not comment on style preferences or
untouched legacy code.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
