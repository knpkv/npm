# @knpkv/review

Provider-neutral review contracts, pure browser runtime transitions, and controlled review UI.

The package owns exact thread identity, complete execution-profile selection, and retained-result presentation. Product adapters keep authentication, CSRF, provider execution, governance, publication, and persistence local.

```ts
import { presentReviewResult, resolveReviewProfile } from "@knpkv/review"
import { ReviewProfileControl, ReviewResultStatus } from "@knpkv/review/react"
```

## Guided reviews

`@knpkv/review/guide` owns the guide and findings schemas, chapter coverage, and
source-line placement. `@knpkv/review/guide/react` exports `GuidePage` and
`GuideUsage`; import `@knpkv/review/guide/styles.css` once when embedding them.
`@knpkv/review/guide/export` exports `exportGuide`, an Effect returning the HTML
and placement counts or a typed `GuideExportError`. It validates inputs and
requires each changed file to appear exactly once. Default Git prefixes and
`--no-prefix` work directly. For custom prefixes, pass `prefixes: { source, destination }`
with the exact `--src-prefix` and `--dst-prefix` values; filenames alone cannot
unambiguously identify arbitrary prefixes. Copies retain their original source
but only their destination is a changed-file identity. CRLF patch records are accepted.

```ts
import { exportGuide } from "@knpkv/review/guide/export"

const page = yield * exportGuide({ guide, patch, findings })
// page.html is one offline document, including styles, fonts, controls, and diagrams.
```

The reader gives Change guide and Review equal tabs. Change guide explains
the problem, changed behavior, and decisions; Review presents the verdict and
findings. Both lead to the same chapter diffs and source-line anchors.

The reader uses Rly primitives and patch diffs, with a chapter index, bounded
prose width, source-side findings, split/unified layouts, code wrapping, and
light/dark/system themes. Markdown accepts paragraphs, headings, lists, links,
callouts, fenced code, and Mermaid. Fence language names may contain punctuation
and be followed by metadata. Raw HTML stays escaped.
Finding summaries and checklist notes render inline code, emphasis, and links.
The finding index keeps its own source-line link; links within its label become
plain labels so anchors never nest. Prose uses softer Rly reading colors; code
spans have subtle backgrounds while fenced examples remain separate blocks.

`guide` retains the Plannotator shape: `title`, `intent`, `sections` containing
`title`, Markdown `overview`, and `diffs` containing `file` and `summary`;
`unplacedFiles`; and `review.gitRef` with optional `review.base`. Optional
`source.pr` contains `url`, `number`, and `title`; optional `generator` contains
`engine` and `model`. Findings contain `checklist` entries with `item`,
`verdict` (`Yes`, `No`, `N/A`), and optional `note`; plus `issues` with unique
numeric `id`, `severity` (`P1` through `P4`), `file`, `summary`, and optional
`line`, `side` (`old` or `new`, default new), `explanation`, `recommendation`, and `status`.
`line` must be a positive integer. A supplied `status` replaces the fix recommendation.
Keep `summary` short; put the trigger, code path, and consequence in Markdown `explanation`.
Optional `source`, `preExisting`, and `openQuestions` retain review context.

Run `pnpm example:guide` in this package for the [fully explained approval example](examples/approval-guide/README.md).
It covers the intended boundary, actual execution, caller-visible results, and test gaps.

### Execution evidence

The optional `guide.usage` array records attributable runs. Each entry needs
`label`, `scope` (`implementation`, `review`, or `guide`), and `source`, a
normalized client-visible identifier for the telemetry record, suitable for HTML
export. Adapters must retain server-private provider locators and credentials
outside the guide: `exportGuide` serializes every guide field into the portable
document. Everything else is optional. For example:

```json
{
  "label": "Security review",
  "scope": "review",
  "source": "Provider receipt run-42",
  "model": "provider/model",
  "inputTokens": 12000,
  "cachedInputTokens": 9000,
  "outputTokens": 1800,
  "durationMs": 95000,
  "cost": { "amount": 0.12, "currency": "USD", "basis": "reported" }
}
```

Counts are nonnegative integers. Input tokens include cached input; cached
tokens are a subset, never an extra charge to add to the total. Duration is
elapsed time for the named run. Cost requires an ISO currency code and
`reported` or `estimated` basis. Supply provider usage or a documented pricing
calculation; the renderer has no model price table. Missing values display
as not recorded, while measured zero stays zero. Cost display preserves the
supplied numeric precision, including sub-cent amounts. Runs stay separate because
implementation, review, and guide sessions may overlap. Product adapters own
telemetry collection, provider locators, storage, and publishing.
