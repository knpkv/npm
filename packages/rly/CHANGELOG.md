# @knpkv/rly

## 0.18.0

### Minor Changes

- [#717](https://github.com/knpkv/npm/pull/717) [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84) Thanks [@konopkov](https://github.com/konopkov)! - Exports `RLY_RELAY_MARK_GLYPH`, the Relay mark's viewBox, stroke width and paths, so a host can draw the mark outside React (an app icon or a notification badge) without copying it; `RelayMark` now renders from it.

- [#713](https://github.com/knpkv/npm/pull/713) [`eb2ddfd`](https://github.com/knpkv/npm/commit/eb2ddfd124b3e8805d886fa26c178aa59231f1b4) Thanks [@konopkov](https://github.com/konopkov)! - RelayMark moves with Relay: `activity` (`idle`, `working`, `attention`) on the mark, its tile, `RelayLauncher`, `RelayPanel` and `RelayDock`, plus a one-shot `entrance` that `RelayPanel` plays as it opens. Motion is opt-in: still under a system or in-app reduced-motion setting.

### Patch Changes

- [#715](https://github.com/knpkv/npm/pull/715) [`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4) Thanks [@konopkov](https://github.com/konopkov)! - Relay's mark shows when Relay is working in the products. relay-product marks the launcher, panel and dock as working while a continuation sent from Relay waits on its answer, or while the product reports its own run through the registration's new `working` field; codecommit-web reports a running PR review. RelayMark's entrance now moves each stroke instead of the whole svg, and a mark that opens already working starts its loop as the entrance ends.

## 0.17.0

### Minor Changes

- [#679](https://github.com/knpkv/npm/pull/679) [`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1) Thanks [@konopkov](https://github.com/konopkov)! - rly's reset lets block containers shrink below their content as flex and grid items (`min-inline-size: 0`; inline content such as icons and labels keeps its automatic minimum), wraps long words and URLs (`overflow-wrap: break-word`), and avoids lone last words (`text-wrap: pretty`) inside rly roots. A component that must not shrink states its own minimum.

- [#696](https://github.com/knpkv/npm/pull/696) [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10) Thanks [@konopkov](https://github.com/konopkov)! - Motion is opt-in: every rly transition and animation now runs only under `prefers-reduced-motion: no-preference`, so a reader who asks for less motion gets none, not just zero-length motion. Adds two easing tokens, `--rly-easing-out` (entering, leaving, answering a press) and `--rly-easing-in-out` (something on screen turning or moving), exported as `RLY_EASING_TOKEN_NAMES`. The `slow` duration drops from 360ms to 300ms. The per-duration `--rly-motion-*-easing` variables stay, as ease-out.

- [#684](https://github.com/knpkv/npm/pull/684) [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b) Thanks [@konopkov](https://github.com/konopkov)! - rly's colour tokens are written in OKLCH (neutrals use hue `none`), and the generated custom properties are `light-dark(oklch(…), oklch(…))`. Every token displays as exactly the sRGB colour it replaced, in both themes.

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.

### Patch Changes

- [#701](https://github.com/knpkv/npm/pull/701) [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32) Thanks [@konopkov](https://github.com/konopkov)! - On a phone, where `Dialog` fills the screen, its title, description and fields now pack at the top one gap apart instead of spreading over the whole height.

- [#694](https://github.com/knpkv/npm/pull/694) [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f) Thanks [@konopkov](https://github.com/konopkov)! - `Text`'s verdict and page-title variants extend their box over Geist's accented capitals and descenders (and give the space back with negative margins), so a focus ring on a display heading no longer cuts through its glyphs and nothing around it moves.

- [#697](https://github.com/knpkv/npm/pull/697) [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96) Thanks [@konopkov](https://github.com/konopkov)! - Controls that stay visually small (the Relay dock and sheet close buttons, the findings "Open" chip and evidence disclosure, the transcript's jump button, table sort headers, and the diff workbench's "Show all files") now take taps across a 44px area through an invisible `::after`, without changing their look.

- [#701](https://github.com/knpkv/npm/pull/701) [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32) Thanks [@konopkov](https://github.com/konopkov)! - Single-row `Tabs` (`data-mobile-layout="single-row"`) no longer overflow by 1px vertically and show a scrollbar: the hairline is drawn inside the scroller, and the selected underline still covers it.

- [#686](https://github.com/knpkv/npm/pull/686) [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f) Thanks [@konopkov](https://github.com/konopkov)! - rly's colour tokens are declared once on `:root` as `light-dark()`; a `[data-theme]` subtree only switches `color-scheme`, and its descendants resolve the matching value. Themed subtrees no longer re-declare every colour, so a themed subtree inside `[data-forced-colors="active"]` keeps the forced system colours.

## 0.16.0

### Minor Changes

- [#654](https://github.com/knpkv/npm/pull/654) [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayDecision`, the confirmation before one Relay write: the exact target and text, Confirm or Don't for that call only, a latch against double confirmation, a danger tone, and outcomes from Posting… to Done with a receipt, Failed, Declined and Expired, announced once per call.

- [#657](https://github.com/knpkv/npm/pull/657) [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayFindings`, Relay's review findings: grouped by location, severity as icon, word and P-number, Accept and Dismiss toggles, Discuss, posting accepted findings one confirmed call at a time, a stale banner that holds line findings until a re-run, and before-side lines that never open a head line.

- [#656](https://github.com/knpkv/npm/pull/656) [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelaySetup`, Relay's in-panel first run: choose a ready agent from real backend status (not checked yet, checking, ready, or unavailable with its cause, fix and Check again), choose a focus, then start, with Start saying what is missing until both are chosen.

- [#659](https://github.com/knpkv/npm/pull/659) [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327) Thanks [@konopkov](https://github.com/konopkov)! - `RelayTranscript` shows a neutral `Note` item for system messages (why a send was refused, a changed registration), attributed to neither turn and not announced.

- [#651](https://github.com/knpkv/npm/pull/651) [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayTranscript`, Relay's conversation: your turns, Relay's prose with in-place code blocks, collapsed tool activity with location citations, run outcomes, a polite run announcer, and scroll that follows new content only while you are at the end.

### Patch Changes

- [#663](https://github.com/knpkv/npm/pull/663) [`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6) Thanks [@konopkov](https://github.com/konopkov)! - `RelayComposer`'s preset slot shrinks with the panel, so a long preset name truncates in its trigger instead of widening the composer past the panel's edge.

- [#676](https://github.com/knpkv/npm/pull/676) [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4) Thanks [@konopkov](https://github.com/konopkov)! - Hover styles apply only on a hover-capable fine pointer, so touch taps no longer leave controls looking hovered. The composer draws the focus ring around its whole box, and a keyboard-highlighted Select option shows the ring, so it no longer looks the same as the checked option.

- [#677](https://github.com/knpkv/npm/pull/677) [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad) Thanks [@konopkov](https://github.com/konopkov)! - The bounded diff view uses logical borders and alignment, and its code is pinned left to right (isolated), so an RTL host never mirrors code. Centred text that can overflow falls back to the start edge where `safe center` is supported (an `@supports` block, so older browsers keep `center`); shrink-wrapped marks and avatars stay plainly centred. Sheets and the Relay dock size to `100dvh` without a `100vh` fallback.

- [#678](https://github.com/knpkv/npm/pull/678) [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408) Thanks [@konopkov](https://github.com/konopkov)! - Clipping containers use `overflow: clip` instead of `hidden`, so they are no longer accidental scroll containers: moving focus to a partly clipped child can't scroll their content out of place, and sticky descendants work. Painting is unchanged.

## 0.15.0

### Minor Changes

- [#642](https://github.com/knpkv/npm/pull/642) [`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb) Thanks [@konopkov](https://github.com/konopkov)! - Load Geist and Geist Mono with `font-display: optional`, so a late font keeps the metric-matched fallback for that page view instead of swapping in and shifting text, and add `RLY_FONT_FACES`, the font files a shell must preload for Geist to render on first load.

- [#648](https://github.com/knpkv/npm/pull/648) [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayComposer`, Relay's auto-growing message box with removable context refs, a run preset, Send and Stop, Ctrl/⌘+Enter to send and an IME guard, and `useRelayDraft`, which keeps each object's draft through close, reopen and resize (optionally a reload) and reuses one request id until the text changes.

- [#646](https://github.com/knpkv/npm/pull/646) [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayPanel`, Relay's frame as a non-modal overlay, a pinned column or a full-screen dialog, with its header, tabs, freshness line, body and composer footer, and `useRelayPresentation` to choose between them; add a `pin` icon.

- [#636](https://github.com/knpkv/npm/pull/636) [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015) Thanks [@konopkov](https://github.com/konopkov)! - Add `useRelaySummon`, Relay's Ctrl/⌘+J keyboard summon: it opens Relay and focuses the composer, takes focus back to the page from inside Relay, closes full-screen Relay, and closes on Escape from inside Relay, handling only the exact chord so other shortcuts reach the host.

## 0.14.0

### Minor Changes

- [#627](https://github.com/knpkv/npm/pull/627) [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayMark`, Relay's new mark (the baton) bare in the current colour or on an agent-coloured `RelayMark.Tile`, with a matching favicon at `@knpkv/rly/relay-mark.svg`, and `RelayLauncher`, the header button that opens Relay with its mark, label and Ctrl/⌘+J hint. `RelayDock`'s trigger now shows the new mark.

### Patch Changes

- [#593](https://github.com/knpkv/npm/pull/593) [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597) Thanks [@konopkov](https://github.com/konopkov)! - Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap wherever glyphs are placed at subpixels (desktop Chrome on Linux as measured, and the usual macOS and Windows defaults); a Linux desktop set to full hinting can still move text slightly. Reading measures and title widths are set in `em` (at the weight each is drawn in) rather than `ch`, whose size follows the font's "0" and changed by 16% on the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.

- [#601](https://github.com/knpkv/npm/pull/601) [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae) Thanks [@konopkov](https://github.com/konopkov)! - Region draws one header in every tone; a tray tints only its body. TimelineRow sets detail and provenance in meta type under the title and shows the actor kind as a plain word instead of an uppercase eyebrow.

## 0.13.0

### Minor Changes

- [#588](https://github.com/knpkv/npm/pull/588) [`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047) Thanks [@konopkov](https://github.com/konopkov)! - Add `StackedBars`: stacked values per period with limit bands above, a shaded window such as the current limit window, width-aware binning, and a single-stop keyboard span selection. Columns out of time order throw an error naming the column. The focus-ring lint now also holds SVG focus strokes to the shared width token, and reserves the focus colour for focus; agent-usage's chart focus stroke uses the token.

## 0.12.1

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.

## 0.12.0

### Minor Changes

- [#571](https://github.com/knpkv/npm/pull/571) [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6) Thanks [@konopkov](https://github.com/konopkov)! - One focus ring everywhere: a solid 2px outline in the focus colour, 2px outside the control, from the new `--rly-focus-ring-width` and `--rly-focus-ring-offset` tokens. The base ring goes from 3px to 2px, and the diff, table, timeline, and toggle rings that used 3px or ad-hoc offsets now match. `lint:colors` rejects a focus outline with a raw width.

## 0.11.0

### Minor Changes

- [#519](https://github.com/knpkv/npm/pull/519) [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5) Thanks [@konopkov](https://github.com/konopkov)! - `ServiceMark` takes a `name` variant: `visible` (default) prints the provider name, and `hidden` prints the glyph only, where an adjacent title already names the provider. The accessible name is present either way. The mark no longer draws a provider-coloured rail.

  Control Center's Services cards use the hidden name, so the provider is no longer printed twice.

## 0.10.0

### Minor Changes

- [#509](https://github.com/knpkv/npm/pull/509) [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc) Thanks [@konopkov](https://github.com/konopkov)! - Controls default to tool density: `Button`, `IconButton`, `Select`, and the `Field` control gain a `dense` size (32px, small radius, sized to text) and use it when no size is given (`ThemeSelect` and the `AgentJob` cancel action too), through new shared `--rly-control-height-*` tokens (`RLY_CONTROL_HEIGHT_TOKEN_NAMES`). Compact `IconButton` is 40px like the other compact controls (it was 44). `ToggleGroup` gains the same dense default, drawn as an outlined row with 1px dividers instead of a tinted track, and its `compact` and `default` sizes now follow the 40px and 48px control heights; the registry lists `dense` as the default size. Coarse pointers keep a 44px target. One-sided accent stripes are gone from rly: diff annotations, the file-tree error, stale findings, agent outcomes, thread evidence, verdict reasons, workset gaps, and the `StatePanel` rail now use an even border or a flat tint, and `lint:stripes`, now part of the repository lint gate, keeps them from coming back. The diff file tree marks the open file with an even ring and draws its guide lines in the neutral divider colour. A neutral `StatePanel` shows no icon unless `icon` names one. Control Center's header actions, Settings inputs and selects, and service setup fields move to the same dense height, so they line up with rly buttons.

  `StateLabel` renders a state as its word and icon in the tone's ink, with no border, tint or padding, so it never reads as a status chip. rly text no longer uses `overflow-wrap: anywhere`: words wrap only between words, and only an unbreakable token breaks (`break-word`), so a squeezed row never splits a word. Control Center Services: the card header keeps the title whole beside its state, and resource rows and test evidence lose their one-sided stripes. Codecommit-web's pull-request state links keep the 32px control target now that the state is a plain word.

## 0.9.0

### Minor Changes

- [#510](https://github.com/knpkv/npm/pull/510) [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1) Thanks [@konopkov](https://github.com/konopkov)! - Add chart foundations: eight series colour tokens plus a neutral remainder (`--rly-color-series-*`), `LimitTrack` (a 0–100% limit with a near mark, a projected extension, and a stale hatch), `TrackKey` for the marks, and `ChartLegend` with `rlySeriesColor`.

- [#505](https://github.com/knpkv/npm/pull/505) [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae) Thanks [@konopkov](https://github.com/konopkov)! - Add `DecisionBar`: approve or reject one named target. The target and its clock stay visible, and both actions carry the target in their accessible names. An `off` state keeps them focusable with the reason linked, and `sending` waits for the server's answer instead of assuming success. `placement="sticky"` pins the bar at thumb reach on phones.

- [#504](https://github.com/knpkv/npm/pull/504) [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76) Thanks [@konopkov](https://github.com/konopkov)! - Add `Hero` and `HeroWord`: the one fact a screen leads with, as a sentence in text ink with its figure inside, plus an optional caption. The `line` size folds it to one line beside a detail, and `display` is for boards read from across a room. `HeroWord` gives only the state word blocked or held ink.

- [#500](https://github.com/knpkv/npm/pull/500) [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613) Thanks [@konopkov](https://github.com/konopkov)! - Add `Region`: one main page region as a bordered surface with a single header row (title, plain count, actions) above a rule. The section is named by its heading, the heading can take programmatic focus through `headingId`, and `tone="tray"` steps the surface down for regions that hold actionable cards.

- [#498](https://github.com/knpkv/npm/pull/498) [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a) Thanks [@konopkov](https://github.com/konopkov)! - Add a `words` size to `StageRail` for rows and facts. Stages read as one line ("Build succeeded, Staging failed: integration tests, Prod waiting") with no markers, chips or owners. Only critical and caution states take ink, and the heading remains for assistive technology.

- [#502](https://github.com/knpkv/npm/pull/502) [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf) Thanks [@konopkov](https://github.com/konopkov)! - Add optional `provenance` to `TimelineRow` events. The marker takes a shape (○ applied automatically, ● approved, ◆ waiting for approval, a hatched square for couldn't read, ▲ flag only) and the label says it in words. A new `TimelineProvenanceKey` keys the shapes. The shapes stay distinct in forced colours.

### Patch Changes

- [#515](https://github.com/knpkv/npm/pull/515) [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4) Thanks [@konopkov](https://github.com/konopkov)! - Region stays inside its container when its title or body holds a token with no break point, such as a long branch name or id. The token breaks only where it cannot fit; words still wrap at spaces.

## 0.8.0

### Minor Changes

- [#486](https://github.com/knpkv/npm/pull/486) [`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d) Thanks [@konopkov](https://github.com/konopkov)! - Add `useStoredTheme`, `useDocumentTheme`, `decodeRlyTheme`, and `ThemeSelect`, so apps share one way to remember, apply, and choose the theme instead of copying storage code. `useStoredTheme` takes an application-chosen key and lazily supplied storage, stays correct through server rendering and hydration, and keeps tabs in sync. `useDocumentTheme` themes `<html>` so the viewport canvas and scrollbars match. `Select` now shows a controlled value's label before its list mounts, including during server rendering.

## 0.7.0

### Minor Changes

- [#478](https://github.com/knpkv/npm/pull/478) [`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b) Thanks [@konopkov](https://github.com/konopkov)! - Add `Notice`, an inline one-sentence message with a state tone, optional action, and opt-in live-region announcement. Use it where packages hand-rolled tinted note paragraphs; `StatePanel` stays for titled, region-level states. `StatePanel` docs now explain that a polite status region must already be mounted to announce reliably, while an assertive alert may announce on insertion. Components that set their own `display` now still honour the native `hidden` attribute, through a new last `rly.state` layer that unlayered application CSS can still override. The open `RelayDock` trigger keeps its layout box and is `inert` instead of `hidden`. `StatePanel` no longer drops a caller-supplied `role` when it is not announcing.

## 0.6.1

### Patch Changes

- [#457](https://github.com/knpkv/npm/pull/457) [`a2527be`](https://github.com/knpkv/npm/commit/a2527be3ddd1f52645fce763df11ecae4868e599) Thanks [@konopkov](https://github.com/konopkov)! - Small cost axis ticks keep distinct labels, a focused chart column keeps its breakdown when the pointer leaves, and `ToggleGroup` no longer reports a change when an arrow key lands on the option already chosen.

## 0.6.0

### Minor Changes

- [#433](https://github.com/knpkv/npm/pull/433) [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452) Thanks [@konopkov](https://github.com/konopkov)! - Add patch-based diff presentation and a reusable guided review reader with portable HTML export. Guides retain chapter coverage and source-line findings, use Rly presentation, and display attributable token usage, cost, and execution time.

  Accept no-prefix and explicitly configured custom-prefix Git patches, CRLF patch
  records, and copied-file identities. Validate usage subsets and source coordinates,
  and replace stale fix guidance when a finding has status.

  Reject overlapping or surplus hunk records, retain diagram updates during active rendering, and keep source attribution and review-context categories visible. Standalone test commands build the export assets first.

  Preserve recorded cost precision and copied source paths, recognize punctuated code-fence languages, and reject non-UTF-8 path bytes instead of collapsing file identities.

  Require file markers for text hunks, document explicit empty prefixes for ambiguous no-prefix paths, and print both guide and review panels through opt-in tab content retention.
  Retain completed diagrams during print media transitions instead of clearing them for an asynchronous system-theme redraw.
  Measure diagrams outside hidden tabs so theme changes preserve their printable dimensions.

  Reject duplicate or contradictory patch records, isolate diagram failures, and display a supplied comparison base.

  Expose a bundled diagram initializer for embedded guides, with host-owned cleanup, theme updates and print preservation. Retain variable-length code fences and ordered-list continuations; reject mode transitions on absent patch sides.

- [#424](https://github.com/knpkv/npm/pull/424) [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet tabs in one compact iPhone row, preserve terminal pointer access, and distinguish Work loading and failure states.

- [#456](https://github.com/knpkv/npm/pull/456) [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59) Thanks [@konopkov](https://github.com/konopkov)! - Add a `ToggleGroup` primitive for choosing one of a few peer options, and a `density="compact"` variant on `EntityTable` whose narrow cards lead with the first column and lay the rest out as a two-column label and value grid.

### Patch Changes

- [#425](https://github.com/knpkv/npm/pull/425) [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029) Thanks [@konopkov](https://github.com/konopkov)! - Remove the scrollbar-like selection line from stacked mobile tabs.

- [#432](https://github.com/knpkv/npm/pull/432) [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225) Thanks [@konopkov](https://github.com/konopkov)! - Replace employer-specific names in fixtures, comments and prototype storage keys with neutral placeholders.

  The Control Center prototype uses a new demo storage namespace. Saved prototype state and theme preferences from the previous namespace are not loaded.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Replace internal project names, keys and work descriptions in fixtures, examples and documentation
  with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
  public package would otherwise see.

  `ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
  declaring the response it wants, instead of providing a layer inside every test body.

- [#452](https://github.com/knpkv/npm/pull/452) [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623) Thanks [@konopkov](https://github.com/konopkov)! - Update `@pierre/diffs` to 1.5.1, keeping the strict style-src theme patch, and `lucide-react` to 1.50.

## 0.5.1

### Patch Changes

- [#400](https://github.com/knpkv/npm/pull/400) [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66) Thanks [@konopkov](https://github.com/konopkov)! - Keep modal Relay focus trapping correct for controls inside nested open ShadowRoots.

## 0.5.0

### Minor Changes

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Add the shared responsive Relay Dock presentation pattern.

## 0.4.1

### Patch Changes

- [#382](https://github.com/knpkv/npm/pull/382) [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2) Thanks [@konopkov](https://github.com/konopkov)! - Run release-independent CodeCommit reviews through authenticated native Codex sandboxes, resolve AWS SSO profiles safely, preserve redacted review failure stages and causes, and make review setup, settings, service health, and narrow-screen navigation clearer.
  Review activity now scrolls independently, follows new output without stealing a reader's position, and keeps a multiline draft composer available while a run is active.

## 0.4.0

### Minor Changes

- [#373](https://github.com/knpkv/npm/pull/373) [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d) Thanks [@konopkov](https://github.com/konopkov)! - Add streamed web Relay progress, configurable prompt-only review profiles and environment skills, reload-safe finding conversations and exact-head re-review, independently scrolling findings and replies, a collapsible changed-file hierarchy, local acknowledge/reject decisions, bidirectional comment-to-diff navigation, and permission-gated publication of accepted findings as native line comments or file-anchored PR comments.

### Patch Changes

- [#372](https://github.com/knpkv/npm/pull/372) [`812468f`](https://github.com/knpkv/npm/commit/812468f8e98326f854b36df1bbc08095bd0c08b3) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade Storybook and keep its Node 26 build output free of the upstream loader deprecation warning.

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.3.0

### Minor Changes

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.2.0

### Minor Changes

- [#304](https://github.com/knpkv/npm/pull/304) [`2e7d563`](https://github.com/knpkv/npm/commit/2e7d563cf3a388ad291d570edb78ce726611ccf8) Thanks [@konopkov](https://github.com/konopkov)! - Cache immutable CodeCommit diff content and render complete pull-request changes through the worker-backed rly workbench with synchronous failure fallback. Expose canonical exact-line focus across split and stacked rly diff presentations.

- [#288](https://github.com/knpkv/npm/pull/288) [`145032b`](https://github.com/knpkv/npm/commit/145032bf3332a6a115d52ea5ed3a998455de87bf) Thanks [@konopkov](https://github.com/konopkov)! - Render application-owned rich line annotations across virtualized, stacked, split, worker-fallback, and bounded synchronous diff presentations while preserving review state and keyboard focus.

- [#266](https://github.com/knpkv/npm/pull/266) [`d973d9a`](https://github.com/knpkv/npm/commit/d973d9a4bb9753f9a907f182c6b14a4528266765) Thanks [@konopkov](https://github.com/konopkov)! - Add a lightweight diff workbench entrypoint for applications that do not load the syntax renderer.

- [#269](https://github.com/knpkv/npm/pull/269) [`2112142`](https://github.com/knpkv/npm/commit/21121422eb3a4f2be9d975ebb6015bc7381dd305) Thanks [@konopkov](https://github.com/konopkov)! - Render complete CodeCommit file changes as an on-demand split or unified line diff, and add a strict-budget rly diff entry backed by the Diffs parser.

### Patch Changes

- [#296](https://github.com/knpkv/npm/pull/296) [`d60165e`](https://github.com/knpkv/npm/commit/d60165e4630dc77b7a46ca05c2a2d206b040da14) Thanks [@konopkov](https://github.com/konopkov)! - Improve first-party Jira and Confluence synchronization compatibility, make connected service controls compact and status-first, and refine pull-request review feedback, keyboard flow, and confirmation.

## 0.1.1

### Patch Changes

- [#251](https://github.com/knpkv/npm/pull/251) [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e) Thanks [@konopkov](https://github.com/konopkov)! - Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
  overrides:

  - **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
    via literal backslash authority delimiter). Pulled in through `ajv`; affects
    `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
  - **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
    `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
    expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

  No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
  vulnerabilities.

## 0.1.0

### Minor Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Introduce the release-oriented rly design-system package with generated,
  validated public entry points and a bounded Storybook catalog. The catalog
  includes documentation, accessibility and interaction checks, deterministic
  Chromium teardown, presentation-state controls, and fail-closed visual change
  classification.

  Add generated semantic color, typography, spacing, shape, and motion tokens;
  light, dark, forced-color, and reduced-motion themes; self-hosted Geist font
  assets; contrast validation; and a fail-closed component color policy.

  Add SSR-safe `GlobalStyles`, controlled `ThemeProvider`, owned accessible
  `Icon`, framework-neutral `LinkProvider`, and custom-target `PortalProvider`
  foundations without exposing router, Radix, or icon-library types.

  Add the first nine owned primitives: `Text`, `Surface`, `Divider`, `Button`,
  `IconButton`, `StateLabel`, `Avatar`, `Skeleton`, and `StatePanel`. Publish their
  semantic CSS as one deterministic component layer with no runtime injection,
  and cover variant, accessibility, interaction, SSR, packed-consumer, and
  responsive Storybook contracts.

  Add controlled-first `Tabs`, `Field`, and `Select` primitives with owned public
  types, Radix-internal keyboard behavior, explicit labeling and error semantics,
  safe portal composition, and compact responsive states.

  Add owned compound `Dialog` and `Sheet` overlays with visible accessible names,
  native inert isolation, focus containment and restoration, scroll locking,
  nested cleanup, compact full-screen layouts, and token-driven motion.

  Add presentation-only provenance and collaborator patterns for all five
  services, explicit freshness and evidence references, named human roles, safe
  avatar fallbacks, controlled `+N people` expansion, compact layouts, and
  forced-color-safe identity.

  Add the deterministic Release Relay presentation contract with 16 stable,
  code-owned SVG symbols, exact compact and hero geometry, runtime tuple
  validation, and golden persisted vectors. Add a giant neutral Verdict with a
  caller-supplied reason and semantic rail, without deriving release identity or
  readiness in the design system.

  Add semantic delivery-stage and relationship patterns with complete
  zero-to-many cardinality, explicit missing endpoints, caller-supplied lifecycle
  and direction, equivalent chain and native-table views, deterministic keyboard
  order, and compact forced-color-safe reflow.

  Add release dossier, preview, workset, entity-shell, entity-table, and activity
  patterns. Cover six release outcomes, six-ticket and arbitrary-cardinality Jira
  worksets, explicit PR and pipeline dimensions, service-specific full-view
  shells, controlled sorting, complete degraded data states, human and agent
  actors, caller-selected dialog or compact-sheet previews, complete collaborator
  slots, visible decision rails, caller-owned shared-transition geometry, and
  focus-safe preview-to-full-view actions.

  Add first-class contextual agent and governed-action patterns with exact
  context/evidence/capability ordering, durable human/agent/system threads,
  provider job progress and truthful terminal states, explicit non-authorizing
  agent proposals, and confirmation-gated named human authorization. Cover
  focus stability, cancellation, 320px dark and forced-color layouts, and
  presentation-only callbacks with no provider or vendor execution.

  Add an isolated complete diff entry with explicit file-content states, a
  500-file-safe inventory, controlled header and semantic findings, and a compact
  bird's-eye workbench. Pin and wrap `@pierre/diffs` `CodeView` with split and
  stacked layouts, wrapping, context, selection, annotations, item versioning,
  scrolling, virtualization, bounded workers, and an announced synchronous
  fallback that never silently omits source changes. Give review findings an
  optional implementation-ready prevention plan covering the enforcement layer,
  target rule, reject/allow fixtures, and known detection boundary.

  Publish a fail-closed, schema-validated agent registry with deterministic
  component, variant, state, accessibility, search, and source metadata. Add
  maintainer scaffolding and package-boundary validation, ship every registry
  artifact through explicit exports, and document the complete design system in
  the indexed workspace docs site with its static Storybook catalog composed at
  a stable nested route.

### Patch Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add canonical per-release Relay threads backed by bounded, authenticated local Codex or Claude turns, and preserve multiline agent answers in rly threads.

- [#141](https://github.com/knpkv/npm/pull/141) [`e966c29`](https://github.com/knpkv/npm/commit/e966c29526522e1eac112533e70e3e39041e3ced) Thanks [@konopkov](https://github.com/konopkov)! - Add the six-state Control Center portfolio with authoritative readiness and
  delivery-stage projections, compact Jira/PR/pipeline relationship totals, and
  large URL-backed All, Need attention, Deploying, and Shipped filters. Include
  the six-release browser reference fixture, recoverable empty views, live count
  coherence, stable focus, and keyboard/back/refresh acceptance coverage.

  Expose stable release-fact identifiers from rly so applications can apply
  service-specific accents without coupling to generated CSS module names.
