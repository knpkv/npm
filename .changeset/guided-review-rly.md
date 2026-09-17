---
"@knpkv/rly": minor
"@knpkv/review": minor
---

Add patch-based diff presentation and a reusable guided review reader with portable HTML export. Guides retain chapter coverage and source-line findings, use Rly presentation, and display attributable token usage, cost, and execution time.

Accept no-prefix and explicitly configured custom-prefix Git patches, CRLF patch
records, and copied-file identities. Validate usage subsets and source coordinates,
and replace stale fix guidance when a finding has status.

Reject overlapping or surplus hunk records, retain diagram updates during active rendering, and keep source attribution and review-context categories visible. Standalone test commands build the export assets first.

Preserve recorded cost precision and copied source paths, recognize punctuated code-fence languages, and reject non-UTF-8 path bytes instead of collapsing file identities.
