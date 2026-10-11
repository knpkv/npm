# Design conformance

Private workspace package. No changeset or npm publication.

Every live state needs a reference. A touched state fails on unwaived copy,
geometry, computed-style or pixel differences. Coverage and stale waivers always
fail. Unchanged legacy drift may be report-only until the product's UTC deadline.
Changing any viewport or theme makes the entire state touched.

## Reference contract

Put refs in `design-refs/<product>/`:

- `screens/<screen>.html`: standalone HTML export, with the design runtime stripped.
  Select state and theme with `?state=<id>&theme=light|dark`. Use viewport width for layout.
- `fixture.json`: `{ "version": 1, "data": { ... } }`. Synthetic role-based data only.
  Both the HTML and live adapter render this exact data. Vendor fonts and assets.
- `manifest.json`: product, live adapter, enforcement, states and a SHA256 file inventory.
- `waivers.json`: reviewed exceptions for actual copy, geometry, token or pixel failures.

Tag the same visible regions on both sides with `data-region="content"`, for example.
Names must be unique per state. Declare every region in the manifest. The gate checks
DOM order, nearest region parent, horizontal page/region overflow, normalized visible
text, and document-space boxes. Geometry tolerance is 2px at 390 and 4px at 1280.
Resolved color, background, font, borders, radius, gaps and padding must match exactly.
HTML pixel comparison allows at most 0.1% different pixels per region and whole frame,
using pixelmatch anti-alias detection. UUIDs are masked in screenshots; UUID and ISO
timestamp copy is normalized. Other timestamps must be deterministic fixture values.

HTML refs fetch the fixture relative to their file and set
`document.documentElement.dataset.designReady = "true"` after rendering it.
The reference server serves only hashed files. External network requests fail.
The file inventory includes the fixture, HTML, scripts, CSS, fonts and images.
Only `manifest.json` and `waivers.json` are outside the hash inventory. Symlinks fail.

See [`design-refs/_fixture/manifest.json`](../../design-refs/_fixture/manifest.json)
for the complete HTML example. Its enforcement block is:

```json
{
  "touched": "required",
  "legacy": { "mode": "report-only", "until": "2026-10-18T00:00:00.000Z" }
}
```

Use `"legacy": "required"` after migration. At the deadline, existing drift becomes
required automatically. Touched means new state or live pixels differing from the
merge-base capture by more than the #844 0.1% threshold, including size changes.
Missing base product means all current states are new. A missing base capture file
for an indexed shot is an infrastructure failure. Removed live states fail coverage.

## PNG references

Canvas-only products can use `source: "png"`. Supply `refs` entries with `viewport`,
`theme`, `image` and `metadata`, plus a product-specific `pixelMaxDiffRatio` between
0 and 1. Each viewport/theme needs a hashed PNG and hashed metadata JSON.
Metadata uses `Snapshot`: `{ "overflow": false, "regions": [...] }`. Each region
contains `name`, visible `copy`, `box` with `x/y/width/height`, nearest region `parent`
or null, resolved `styles`, and horizontal `overflow`. Array order is DOM order.
The metadata and pixels must describe the same unframed image at device scale 1.
Missing metadata fails decoding; missing style values fail equality.
Copy, geometry and tokens keep the HTML rules. Only perceptual tolerance changes.

## Live adapter

`manifest.live` names the workspace package to build and a repository-relative
TypeScript adapter. Export `start: StartProduct`. Return `LiveProduct.of(...)` with
an origin, independent route/state inventory, `seed(page, fixture, identity)` and
`ready(page, identity)` effects. Acquire servers and other resources in the supplied
scope. `seed` runs before navigation. `ready` runs afterward.

The inventory must come from the application, independently of reference states.
Each live route needs at least one state. Inventory states supply screen, state,
route, viewports and themes. The gate also checks every implemented reference has
a capture. Designed states may precede implementation in a ref PR.
The adapter's origin is the only allowed live network origin; fake provider I/O
inside the application. The toy adapter is [`scripts/fixture.ts`](scripts/fixture.ts).

Both sides use fresh Chromium contexts with a fixed clock, reduced motion,
UTC/en-US, settled fonts, blurred focus and scroll origin. Control Center's #844
suite imports these settings and retains its own framing and functional assertions.

## Waivers and reference review

A waiver names screen, state, region, rule, reason, detail and HTTPS decision link.
Optional viewport/theme narrow its scope. `region: "*"` names the whole frame;
it is not a wildcard matching all regions. Each waiver must match an actual failure.
A stale waiver fails even during legacy grace. Coverage and hash integrity cannot
be waived. A failure can only be waived by the exact rule and region it names.

Waiver authority belongs to the repository owner. CODEOWNERS assigns waiver files
to that user; it only binds once the main ruleset requires code-owner review.
CI flags every waiver-file change with a neutral annotation and job summary.
That flag does not fail CI. Review decides whether the change is authorized.
Labels never waive a failure.

Export and review refs first, in a PR touching only `design-refs/<product>/**`.
The product's design reviewer and coordinator review ref changes. Only waiver
changes need owner approval. Mark new states `designed`, merge the ref PR, then
implement in a separate PR and mark them `implemented`.
Phase 0 includes no real-product onboarding. `_fixture` is reserved for gate tests.
Its deliberate failures are asserted by Playwright, so its CI matrix entry runs
those assertions instead of accepting its intentionally failing conformance verdict.

## Running

Under the machine's build/browser baton:

```sh
pnpm --filter @knpkv/design-conformance build
pnpm design:check --product <product> --state <screen>/<state>
pnpm --filter @knpkv/design-conformance exec tsx scripts/base.ts <product> <base-directory>
pnpm design:check --product <product> --base <base-directory> --output <report-directory>
pnpm --filter @knpkv/design-conformance test:browser
```

`--state` limits local checks and matching waivers to that state; CI always checks
the complete inventory. `--capture-only` writes live shots and `captures.json` for
base comparison. A complete run writes `result.json`, `summary.md`, `index.html`,
and reference/live/diff PNGs. Required findings exit nonzero. Legacy grace findings
stay visible in the report and workflow summary.

The workflow discovers one matrix job per manifest, builds the adapter's workspace
dependencies, captures the merge base with its own adapter, then checks PR captures.
It uses read-only repository permissions and uploads reports on success and failure.
The phase-0 toy test takes two live passes plus one reference pass over 36 shots.
Product runtime grows with states × viewports × themes; use one Chromium worker.
