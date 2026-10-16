# @knpkv/review

Provider-neutral review contracts, pure browser runtime transitions, and controlled review UI.

The package owns exact thread identity, complete execution-profile selection, and retained-result presentation. Product adapters keep authentication, CSRF, provider execution, governance, publication, and persistence local.

## Installation

Headless imports from `@knpkv/review` do not need Rly. Rly is an optional peer so
contract-only consumers do not install the UI dependency tree.

Install `@knpkv/rly` explicitly when using `@knpkv/review/react`,
`@knpkv/review/guide`, `@knpkv/review/guide/react` or `@knpkv/review/guide/export`.
The guide entry includes Rly-backed diff placement as well as schemas. React UI
and guide exports also require the React peers:

```sh
pnpm add @knpkv/review @knpkv/rly react react-dom
```

```ts
import { presentReviewResult, resolveReviewProfile } from "@knpkv/review"
import { ReviewProfileControl, ReviewResultStatus } from "@knpkv/review/react"
```

## Workspace readings

`ReviewWorkspace` joins the current immutable PR identity with a retained completed `ReviewRun`,
cached conversation threads and an independent checks reading. The run keeps its reviewed base/head
when the current PR moves; a suggested patch must name that reviewed head and its anchored file.
Unknown checks, absent runs and unavailable conversations remain explicit. `ReviewRunReading`
distinguishes `NotRecorded`, `Ready` and `Unavailable`; unavailable history never discards the
current diff or comments. A conversation failure
distinguishes missing cache, oversized output and corrupt data. Adapters must state which sources
they read; a CodeCommit cache does not establish Slack availability.

Findings preserve P0 through P4, axis and confidence when reported, and nullable provenance when
the producer does not report it. Explain output remains separate from findings. Thread identity is
the source and thread ID within the exact PR reading; message authors are display data. Messages
retain their own timestamp and deletion state. Schemas bound text, threads and messages, and reject
duplicate thread identities. Decode persisted or transported data with `onExcessProperty: "error"`.
These contracts supply no provider, publication or fix-execution authority.

## Guided reviews

`@knpkv/review/guide` owns the guide and findings schemas, chapter coverage, and
source-line placement. `@knpkv/review/guide/react` exports `GuidePage` and
`GuideUsage`; import `@knpkv/review/guide/styles.css` once when embedding them.
For Mermaid in an embedded page, mount the bundled initializer on a wrapper after
React commits, and return its cleanup when the wrapper unmounts. No separate
Mermaid dependency or security configuration is needed:

```tsx
import { mountGuideDiagrams } from "@knpkv/review/guide/diagrams"
import { GuidePage } from "@knpkv/review/guide/react"
import { useEffect, useRef, type ComponentProps } from "react"

export const EmbeddedGuide = (props: ComponentProps<typeof GuidePage>) => {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (root.current !== null) return mountGuideDiagrams(root.current)
  }, [])
  return (
    <div ref={root}>
      <GuidePage {...props} />
    </div>
  )
}
```

The initializer handles newly mounted content, theme changes and print lifecycle;
ordinary fenced code does not start a Mermaid render. Without JavaScript, Mermaid
remains source text. Standalone exports initialize diagrams automatically.

When embedding guides as separate React roots in one document, the host must choose
a distinct, stable React `identifierPrefix` for each root. Pass the same prefix
to the server renderer and `hydrateRoot`; sibling guides in one root already share
React's ID coordination. For example, the host can render one slot with
`renderToString(<GuidePage {...props} />, { identifierPrefix: "review-left-" })`
and hydrate that markup with
`hydrateRoot(slot, <GuidePage {...props} />, { identifierPrefix: "review-left-" })`.
Give a second independent slot a different prefix. See [React's `useId` guidance](https://react.dev/reference/react/useId#using-the-same-id-prefix-on-the-client-and-the-server).

`@knpkv/review/guide/export` exports `exportGuide`, an Effect returning the HTML
and placement counts or a typed `GuideExportError`. It validates inputs and
requires each changed file to appear exactly once. Default Git prefixes work
directly. For `--no-prefix`, pass `prefixes: { source: "", destination: "" }`;
real paths such as `a/file.txt` and `b/file.txt` otherwise resemble default
prefixes. Other custom producers must pass `prefixes: { source, destination }`
with their exact `--src-prefix` and `--dst-prefix` values. Copies retain their original source
but only their destination is a changed-file identity. CRLF patch records are accepted.
Duplicate current paths, contradictory status headers, incomplete text records and
mixed binary/text bodies are rejected. Empty-file additions and deletions, mode changes,
and pure renames or copies remain valid Git change evidence.

Printing includes both change intent and review verdict, regardless of the selected
tab. Screen reading retains one visible panel and keyboard tab navigation.
Completed diagrams retain their colors during print capture; system-theme redraws
resume when the browser returns to screen media.
Diagram measurement runs outside hidden tab panels so changing theme from the review
panel still produces a complete printable diagram.

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
and be followed by metadata. Raw HTML stays escaped. A failed Mermaid block displays
its own error without preventing adjacent diagrams from rendering.
Finding summaries and checklist notes render inline code, emphasis, and links.
The finding index keeps its own source-line link; links within its label become
plain labels so anchors never nest. Prose uses softer Rly reading colors; code
spans have subtle backgrounds while fenced examples remain separate blocks.

`guide` retains the Plannotator shape: `title`, `intent`, `sections` containing
`title`, Markdown `overview`, and `diffs` containing `file` and `summary`;
`unplacedFiles`; and `review.gitRef` with optional `review.base`. The header shows the
head and any supplied comparison base. Optional
`source.pr` contains `url`, `number`, and `title`; optional `generator` contains
`engine` and `model`. Findings contain `checklist` entries with `item`,
`verdict` (`Yes`, `No`, `N/A`), and optional `note`; plus `issues` with unique
numeric `id`, `severity` (`P0` through `P4`), `file`, `summary`, and optional
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

### Thread projection

`reviewWorkspaceThreads` joins the readable run and conversation snapshots without changing thread identities, anchors or dispositions. It returns a typed `ThreadsConflict` on duplicate source/id within or across snapshots. A UI must show that conflict separately; it must not replace it with an empty list or an unavailable-history state.

P0/P1 finding rows form `primary`; P2-P4 form `secondary`, intended for the collapsed group. Both use the schema's severity order and preserve input order for ties. Non-finding `conversations` remain a separate list in run-then-conversations input order. The total counts all threads, without filtering on resolved or disposition. `NotRecorded` is known absence; an unavailable run or conversation snapshot yields `{ _tag: "AtLeast", n }` instead of an exact total. AtLeast zero means unknown, never zero threads. This projection performs no reads, mutations or review commands.

`reviewRunReadingForWorkspace` derives presentation from a decoded workspace. NotRecorded and Unavailable keep their original object and reason. A readable run becomes Current only when namespace, subject, revision, base and head all match the reading identity, with null base equal only to null base. DifferentRevision keeps the original immutable run and the current identity; it makes no ancestry claim and changes no persisted/wire record.

`currentReviewLineFindings` accepts only the Current variant. It returns non-outdated line-anchored findings in recorded order, preserving their thread/finding objects. General, file-level and outdated findings stay with the parent index/read panels. A renderer still verifies each candidate path/side/line exists in the exact diff and keeps unplaced rows visible separately. Current is relative to this read's identity, never write permission: command owners still recheck head, permission and idempotency.
