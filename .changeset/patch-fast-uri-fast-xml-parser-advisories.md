---
"@knpkv/confluence-to-markdown": patch
"@knpkv/codecommit-core": patch
"@knpkv/control-center": patch
"@knpkv/rly": patch
---

Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
overrides:

- **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
  via literal backslash authority delimiter). Pulled in through `ajv`; affects
  `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
- **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
  `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
  expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
vulnerabilities.
