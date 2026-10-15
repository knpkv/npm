# Design conformance

Private workspace package. No changeset or npm publication.

Every live state needs a reference. A touched region fails on unwaived copy,
geometry, computed-style or pixel differences. Coverage and stale waivers always
fail. Unchanged legacy drift may be report-only until the product's deadline.
Changing one region, viewport or theme does not promote inherited drift in another.

## Reference contract

Put refs in `design-refs/<product>/`:

- `screens/<screen>.html`: standalone HTML export, with the design runtime stripped.
  Select state and theme with `?state=<id>&theme=light|dark`. Use viewport width for layout.
- `fixture.json`: `{ "version": 1, "data": { ... } }`. Synthetic role-based data only.
  Both the HTML and live adapter render this exact data. Vendor fonts and assets.
- `manifest.json`: product, live adapter, enforcement, states and a SHA256 file inventory.
- `waivers.json`: reviewed exceptions for actual copy, geometry, token or pixel failures.

Tag the same visible regions on both sides with `data-region="content"`, for example.
Names must be unique per state. `frame` is reserved for whole-frame artifact keys
and paths; manifest decoding rejects it for both HTML and PNG states.
Declare every region in the manifest. The gate checks
DOM order, nearest region parent, horizontal page/region overflow, normalized visible
text, and document-space boxes. Geometry tolerance is 2px at 390 and 4px at 1280.
Resolved color, background, font, painted borders, radius, gaps and padding must match exactly.
Only complete width/style/color shorthands with a known border style are normalized.
Supported computed colors are numeric comma-separated `rgb()`/`rgba()` and complete `oklch()` with optional alpha.
OKLCH accepts `none` in each of its three component slots and in alpha; chroma also accepts the computed
`calc(infinity)` serialization. Numeric alpha, including exponent notation, must remain within 0 to 1. Percentages and angle units resolve to numbers before capture.
RGB missing-component and color keywords resolve to numeric legacy RGB, or to `color(srgb …)`;
that separate function remains strict, like other unsupported color spaces.
RGB channels may be fractional and must remain within 0 to 255.
Other color forms, incomplete functions and trailing tokens stay strict. These forms follow
[computed color serialization](https://www.w3.org/TR/css-color-4/#serializing-color-values).
An unpainted border has zero width or style `none`; its color and style do not affect token comparisons.
Style `hidden` always stays significant, including at zero width, because it suppresses adjacent collapsed-table borders.
Raw captured styles stay unchanged, and painted-border changes still fail both reference and touched-region checks.
HTML pixel comparison allows at most 0.1% different pixels per region and whole frame,
using pixelmatch anti-alias detection. UUIDs are masked in screenshots; UUID and ISO
timestamp copy is normalized. Other timestamps must be deterministic fixture values.

HTML refs fetch the fixture relative to their file and set
`document.documentElement.dataset.designReady = "true"` after rendering it.
The reference server serves the exact verified bodies retained by `loadReferences`,
including JSON metadata and PNG bytes. Rewriting or deleting reference files after
validation does not change that capture. Unlisted paths remain 404. External network requests fail.
Reference body settlement races successful completion against that request's failure event;
interrupted or cancelled transfers fail with `ReferenceFailure` even after successful headers
and page readiness. Context closure and global timeouts are not completion signals.
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
required automatically. Touched means a new shot/region, or that region's live pixels
differing from its merge-base crop by more than the #844 0.1% threshold, including size
changes. Copy, nesting and overflow are compared directly. Computed styles use the same
unpainted-border normalization as reference comparisons; geometry uses the existing 2px/4px tolerance. Whole-frame `*` pixel findings are required only
when a changed named region also fails pixels, or pixels outside named regions changed.
The outside comparison counts the original comparator's significant pixels outside
both captures' region boxes; it does not change anti-alias detection or thresholds.
Frame growth contained by a matching named region does not promote inherited drift.
Global geometry still tracks overflow and membership changes. `result.json` records
`touchedRegions` and `outsidePixelsChanged` for each exact screen/state/viewport/theme.
All inherited findings remain listed with their reference drift in HTML and CI summaries.
The PR's refs, fixture and adapter drive both captures. During onboarding, the base
app is captured even when its checkout has no refs or gate package. A state is new
only when absent from the base live inventory. A missing base live package means
all current states are new only for a product with no base manifest. For an existing
product, a missing base package fails. Every existing product's `live.package` change
also fails, even if the destination package exists on the base. Package migrations
need a path that preserves the previous package's live inventory.
Ref-only PRs leave states untouched, while coverage,
integrity and waiver checks still apply. A missing base capture file for an indexed
shot is an infrastructure failure. Each capture writes `<shot>-live.json` beside its
PNG so base crops use the base's own region boxes. Missing base metadata also fails;
old saved base evidence must be recaptured. Removed live states fail coverage.

The deadline decodes to a UTC instant; ISO offsets and date-only values are accepted.
Date-only values expire at UTC midnight. Impossible calendar dates fail decoding.

## PNG references

Canvas-only products can use `source: "png"`. Supply `refs` entries with `viewport`,
`theme`, `image` and `metadata`, plus a product-specific `pixelMaxDiffRatio` between
0 and 0.05 inclusive. Start with 0.02, a 2% mismatch budget. This is an explicit
manifest value, not an implicit decoder default. The 5% cap permits modest canvas
renderer differences while requiring at least 95% of compared pixels to agree
under pixelmatch's anti-alias rule.
Larger accepted differences need a reviewed pixel waiver rather than a threshold
that can disable the check. Each viewport/theme needs a hashed PNG and hashed metadata JSON.
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

The adapter and live inventory inputs belong under the named product's
`packages/<package>/` directory. Manifest decoding enforces adapter ownership.
Review inventory dependencies, including dynamic imports and file reads, for the same boundary.

Routes are origin-relative paths with optional query strings and fragments, such
as `/?range=7d&timeZone=UTC#usage/limits`. Navigation preserves the complete route,
including application-owned `state` and `theme` query keys. The adapter seeds capture identity separately. Navigation
waits for the adapter's `ready` effect before capture. The adapter must settle
its hash router and asynchronous UI. Absolute, protocol-relative and backslash
URLs fail the route schema.

`start(fixture, repository)` must load the live app and its inventory from that
repository's built package. Base capture supplies the merge-base checkout here;
a static import of PR application code would invalidate the comparison.

Only declared reference files, manifests and waivers qualify for the refs-only
exemption. Adapter paths and unlisted live inventory/code paths do not qualify.
Changing a manifest's live package or adapter also removes the exemption.
State-scoped runs filter the original live route table; they never create a
missing route entry from a selected state.

The inventory must come from the application, independently of reference states.
Each live route needs at least one state. Inventory states supply screen, state,
route, viewports and themes. The gate also checks every implemented reference has
a capture. Designed states may precede implementation in a ref PR.
The adapter's origin is the only allowed live network origin; fake provider I/O
inside the application. The toy adapter is [`scripts/fixture.ts`](scripts/fixture.ts).

Both sides use fresh Chromium contexts with a fixed clock, reduced motion,
UTC/en-US, settled fonts, blurred focus and scroll origin. Control Center's #844
suite imports these settings and retains its own framing and functional assertions.

Before sampling regions, the conformance runner finishes finite animations,
resets infinite animations and disables transitions. UUID masking and native paint
readiness precede both metadata and screenshots. Screenshots keep that frozen frame
with `animations: "allow"`; they do not perform a second animation reset.
Script-created `element.animate()` calls during capture are cancelled and produce
a typed `BrowserFailure`, even if they start after metadata sampling. New CSS
animation identities also fail, including finished forwards-filled animations.
Capture-phase `animationstart`, `animationcancel` and `transitionrun` events retain
late CSS motion evidence after no-fill animations disappear from `getAnimations()`.
The runner finishes/cancels pre-existing motion and waits for native paint to
deliver its events before installing those listeners. Every subsequent motion
event is late; there are no fill-mode-dependent allowances. Motion started by
a freeze-event handler must also pass the guard before metadata sampling.
Region images are crops of the same full-frame PNG; capture never scrolls to a
region. A CSS-visible region entirely outside the frame or with zero width or
height retains its actual box and all metadata. It has typed `OffFrame` pixel
evidence with no region image. Region sizes must be finite and non-negative;
membership, copy, geometry, order and nesting still compare normally. Its pixel finding follows
the same required, legacy report-only and waiver decisions as other drift.
Partially clipped regions keep their frame intersection. The temporary animation guard and transition style are removed on success or failure.
The
installed clock fakes ordinary `requestAnimationFrame`; Playwright's RAF polling
uses its preserved native callback. Full-page dimensions must be nonzero and at
most 16,384 physical pixels per axis before the screenshot protocol call. This is
a conservative capture bound, not a layout tolerance.

Capture contexts block service workers and fail attempted registrations. HTTP
requests and WebSockets are restricted to the capture origin. Chromium CDP Fetch
interception checks each redirect hop before dispatch. Additional pages and popup
requests are rejected; each capture owns one page. This preserves same-origin
redirects and their final URL. Its session stays active until the context closes. Browser-local `about:`, `data:` and
`blob:` URLs are allowed. Base and output directories must resolve to different
canonical filesystem paths, including through symlinks.

Reference HTTP requests also require an exact path in the SHA256 inventory;
query strings and fragments do not change file identity. Every reference response
must be 2xx with a completed body. Unlisted requests, HTTP errors and failed
transfers produce `ReferenceFailure`, even if the page signals readiness.
Reference WebSockets have no hashed-file representation and are rejected.
Live captures retain their same-origin application behavior.
The product root itself must be an ordinary directory, checked before resolving
its canonical path; a symlink in an ancestor does not make the product root a link.

CI discovers the union of merge-base and current products. A deleted reference
product retains its job and fails when its manifest cannot be loaded. Product
decommissioning has no automatic exemption. The local 3 GiB memory policy applies
only when `/proc/meminfo` exists; read errors and invalid memory information still
fail. Directory-symlink browser regressions run on Linux/macOS and skip Windows,
where creating symlinks requires additional privileges.

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

Base-checkout commands and discovery fixtures clear inherited repository-local
`GIT_*` variables with explicit `extendEnv: true`. A hook's repository and index
must not override the command's checkout. The sentinel regression runs discovery
under hook-like routing and verifies that its HEAD and staged index stay unchanged.

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
dependencies, captures the merge-base app with the PR's adapter, then checks PR captures.
It uses read-only repository permissions and uploads reports on success and failure.
The phase-0 toy test takes two live passes plus one reference pass over 36 shots.
Product runtime grows with states × viewports × themes; use one Chromium worker.

Capture watches main-frame `framenavigated` and `load` events from before font
settlement until evidence completes. Navigation or reload fails immediately with
`CaptureNavigationFailure`, naming the shot and destination, even if the screenshot
protocol call is pending. Iframe navigation remains allowed; listeners are removed
on success, failure and interruption. There is no timeout retry or framing fallback.
Reference pages must update in place on breakpoint changes: Chromium full-page
capture can transiently change the emulated viewport and trigger those listeners.
