# @knpkv/herdr-connect

## 0.30.0

### Minor Changes

- [#1059](https://github.com/knpkv/npm/pull/1059) [`82ed117`](https://github.com/knpkv/npm/commit/82ed117458771d21b61c4c5a4b66b2a9df44a64a) Thanks [@konopkov](https://github.com/konopkov)! - Tell a computer without Herdr from one whose Herdr isn't running, and tidy the standalone hub.

  - Breaking type change in `@knpkv/herdr-fleet`: `HostDetails` and `HostStatus` carry one `repository` object (`{ path, branch, revision, dirty }`, or `null` on a standalone computer) that replaces the separate `branch`, `revision` and `dirty` fields.
  - `AgentInventory` gains an optional `unavailableReason` (`herdr_not_installed` or `herdr_not_running`), and Connect's peer failure reasons gain the same two values. hostd reports a missing Herdr command as not installed and a list command that fails as not running.
  - Connect on a standalone computer shows "Herdr isn't installed" or "Herdr isn't running" (with Retry) instead of "localhost didn't answer", and its empty state names this computer.
  - `FleetService` refuses jobs a host has not set up at run time too, whatever composed its operations.
  - A configuration file that a case-insensitive volume lists under another case is read, not replaced by standalone defaults.

### Patch Changes

- Updated dependencies [[`82ed117`](https://github.com/knpkv/npm/commit/82ed117458771d21b61c4c5a4b66b2a9df44a64a)]:
  - @knpkv/herdr-fleet@0.18.0
  - @knpkv/herdr-work@0.12.11

## 0.29.8

### Patch Changes

- Updated dependencies [[`4c214b7`](https://github.com/knpkv/npm/commit/4c214b749c52cf37087a5b68e8e7269192def46c)]:
  - @knpkv/herdr-fleet@0.17.0
  - @knpkv/herdr-work@0.12.10

## 0.29.7

### Patch Changes

- [#1041](https://github.com/knpkv/npm/pull/1041) [`6e6d029`](https://github.com/knpkv/npm/commit/6e6d029fd0979aca90815ab4a0a6d8bed5967887) Thanks [@konopkov](https://github.com/konopkov)! - READMEs open with "Run it on its own": the `npx` command, its port, and what it runs without. Packages with no executable say where they run instead. CodeCommit web no longer claims it needs Bun; only the terminal UI does.
- Updated dependencies [[`6e6d029`](https://github.com/knpkv/npm/commit/6e6d029fd0979aca90815ab4a0a6d8bed5967887)]:
  - @knpkv/agent-usage@0.11.3

## 0.29.6

### Patch Changes

- Updated dependencies [[`7015e2c`](https://github.com/knpkv/npm/commit/7015e2cd1315f80a6198e62c0344bb41cb3d68dd), [`bf62e19`](https://github.com/knpkv/npm/commit/bf62e19a1db55acd14169dbd315e694cc9e15e8a), [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2), [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2)]:
  - @knpkv/rly@0.24.0
  - @knpkv/herdr-fleet@0.16.0
  - @knpkv/agent-usage@0.11.2
  - @knpkv/herdr-work@0.12.9

## 0.29.5

### Patch Changes

- [#997](https://github.com/knpkv/npm/pull/997) [`4f84e0a`](https://github.com/knpkv/npm/commit/4f84e0a2f45cffb7b2ecf273a9af23545403671f) Thanks [@konopkov](https://github.com/konopkov)! - Mark drawn lines that the stricter stripe lint now reads as top-edge bars: the usage chart's legend line swatches and the archive spinner's arc each carry a `stripe-ok` reason. No visual change.
- Updated dependencies [[`4f84e0a`](https://github.com/knpkv/npm/commit/4f84e0a2f45cffb7b2ecf273a9af23545403671f), [`4f84e0a`](https://github.com/knpkv/npm/commit/4f84e0a2f45cffb7b2ecf273a9af23545403671f)]:
  - @knpkv/rly@0.23.1
  - @knpkv/agent-usage@0.11.1

## 0.29.4

### Patch Changes

- Updated dependencies [[`325b61d`](https://github.com/knpkv/npm/commit/325b61d2d460069ff0f62f3f3eb3c678db4e8c6b)]:
  - @knpkv/agent-usage@0.11.0

## 0.29.3

### Patch Changes

- Updated dependencies [[`4a47179`](https://github.com/knpkv/npm/commit/4a47179344419423632e32045c9e53d4dafa3bee)]:
  - @knpkv/herdr-fleet@0.15.0
  - @knpkv/herdr-work@0.12.8

## 0.29.2

### Patch Changes

- Updated dependencies [[`7603f36`](https://github.com/knpkv/npm/commit/7603f3641fb7d2658f93d4ce45d8949aeb9ecc35)]:
  - @knpkv/herdr-fleet@0.14.0
  - @knpkv/herdr-work@0.12.7

## 0.29.1

### Patch Changes

- Updated dependencies [[`311bf0f`](https://github.com/knpkv/npm/commit/311bf0fd1c5a62de3fdb9a0142debbee2098eda0)]:
  - @knpkv/herdr-fleet@0.13.0
  - @knpkv/herdr-work@0.12.6

## 0.29.0

### Minor Changes

- [#952](https://github.com/knpkv/npm/pull/952) [`31be523`](https://github.com/knpkv/npm/commit/31be52376da7100b172a8fc620f9c967892d01c3) Thanks [@konopkov](https://github.com/konopkov)! - Render typed reading, writing, testing, waiting, blocked, failing, done and unknown task evidence with distinct motion and settled poses. Keep task updates stable, queue changes through finite one-shots, and respect reduced motion, forced colours and offscreen pause. Existing callers without task evidence keep their state presentation.

## 0.28.2

### Patch Changes

- [#941](https://github.com/knpkv/npm/pull/941) [`17869e1`](https://github.com/knpkv/npm/commit/17869e1525f0805bc418f34ee51294632e56259c) Thanks [@konopkov](https://github.com/konopkov)! - Draw stage creatures at the creature motion designs' framing: each body keeps its native reference size, 40 reference units across the stage, so a bean fills about 67% of the stage width instead of 78%. Stage slot sizes are unchanged.

## 0.28.1

### Patch Changes

- [#929](https://github.com/knpkv/npm/pull/929) [`2801b6d`](https://github.com/knpkv/npm/commit/2801b6de0ba87ae085e2648d982b7ea62de595ed) Thanks [@konopkov](https://github.com/konopkov)! - Tag Usage Limits regions for design conformance and render its successful empty state with the designed notice and token-reading action. Other states retain their existing layout.

## 0.28.0

### Minor Changes

- [#933](https://github.com/knpkv/npm/pull/933) [`ca9f6a2`](https://github.com/knpkv/npm/commit/ca9f6a23a0cfd6ab1fdd21804156791864fbef07) Thanks [@konopkov](https://github.com/konopkov)! - Add optional task-kind evidence and seeded idle motion across agent rows, cast and stage. Idle creatures share the hue allocator's stable identity seed, vary tempo, amplitude and phase, and add one family-dependent habit. Preserve existing motion when evidence is absent, pause offscreen work, and keep reduced-motion, forced-colour, stale and closed views still.

## 0.27.2

### Patch Changes

- Updated dependencies [[`48a942e`](https://github.com/knpkv/npm/commit/48a942e637e0fd0417027b3f1fae5400df5ce50b)]:
  - @knpkv/herdr-fleet@0.12.0
  - @knpkv/herdr-work@0.12.4

## 0.27.1

### Patch Changes

- Updated dependencies [[`485fe8f`](https://github.com/knpkv/npm/commit/485fe8f4db2c273ca85181d3712609ed1661bbce)]:
  - @knpkv/herdr-fleet@0.11.0
  - @knpkv/herdr-work@0.12.3

## 0.27.0

### Minor Changes

- [#902](https://github.com/knpkv/npm/pull/902) [`6e3abc8`](https://github.com/knpkv/npm/commit/6e3abc863ecf98f1b367643421964743ab971459) Thanks [@konopkov](https://github.com/konopkov)! - Keep completion state scoped to each agent, ignore stage reactions on rows and cast, and retain the last served hue in persisted pins while an agent is away. Keep all 1,024 supported directory identities cached across polls.

## 0.26.0

### Minor Changes

- [#895](https://github.com/knpkv/npm/pull/895) [`fdbca63`](https://github.com/knpkv/npm/commit/fdbca63a2a259e25f61ad044feec713f8e1c0550) Thanks [@konopkov](https://github.com/konopkov)! - Add scoped, single-flight optional hue enrichment and bind it to the hub's server lifetime. Return an uncoloured directory when hue permission finalization exceeds its wait budget, while keeping mandatory activity observations independent. Shutdown interrupts the owned worker, joins for at most two seconds and closes its connection, logging a typed warning if uninterruptible cleanup remains pending.

## 0.25.0

### Minor Changes

- [#857](https://github.com/knpkv/npm/pull/857) [`ab70d8a`](https://github.com/knpkv/npm/commit/ab70d8abd85e2470e0ad5667b8846e2d003e519e) Thanks [@konopkov](https://github.com/konopkov)! - Draw stable circle, squircle, pear, star and bean agent identities with flat colour families and state faces. Add optional hue, accessory, mood, talking and replayable stage reaction props, with closed and reduced-motion variants.

  Canonicalize host casing for shape and fallback palette seeds, and share shape selection with persisted hue reservations. Upper-case host labels adopt their canonical lower-case shapes once, together with the rev6 redraw.

  Match the rev6 body selector: unsigned FNV-1a of the lowercase host and stable ID payload without its transport `agent-` prefix, bits 8 upward modulo five. Names never select bodies. Existing stored body kinds refresh in the allocation transaction before overflow checks; mixed motion phases keep their identity. Every agent adopts this shape rule once with the redraw. Overflow agents whose new shape collides with an earlier holder of their hue may change colour once on upgrade; exclusive reservations stay fixed, and an unavoidable repeat keeps its recorded hue.

  Use canonical stable IDs for first-sighting hue allocation, with unsigned FNV-1a modulo eight and per-host forward probing. Existing recorded families remain unchanged. Match state-tone circular rings, open idle and ready faces, neutral stale readings and curved closed lashes, and use 40px archive row creatures.

  Match Home row framing and thin state rings, including 36px phone and 40px desktop archive slots. Fleet row tracks and app stage sizes stay unchanged.

  Replay every poke effect together, settle done celebrations immediately under reduced motion, and reuse bounded identity geometry across renders. Probe repaired overflow hues from their recorded family, export the appearance prop types from the surface entry, and keep long desktop pins inside the viewport.

## 0.24.1

### Patch Changes

- [#888](https://github.com/knpkv/npm/pull/888) [`b82fa1e`](https://github.com/knpkv/npm/commit/b82fa1ea10d6ba73d79e15a8621d1ea076d21741) Thanks [@konopkov](https://github.com/konopkov)! - Share one five-second acquisition and SQL retry budget across relationship and activity writes in a local inventory. Reporter peers receive the exhausted operation's safe busy metadata before their transport deadline instead of losing it to repeated per-write budgets. Keep post-commit finalization outside the lock timeout and under the store permit.

- [#887](https://github.com/knpkv/npm/pull/887) [`4552a1f`](https://github.com/knpkv/npm/commit/4552a1f2192c3d7fb2e91a84d11c5c84e449d8bd) Thanks [@konopkov](https://github.com/konopkov)! - Let post pages read retained reports during local post and self-state write backoff. Keep page SQL read-only and secure lazy database sidecars to 0600 before returning, without waiting for the writer transaction permit.

## 0.24.0

### Minor Changes

- [#877](https://github.com/knpkv/npm/pull/877) [`6de50ff`](https://github.com/knpkv/npm/commit/6de50ff3b833224069a5e2b4460d762e94c98002) Thanks [@konopkov](https://github.com/konopkov)! - Recover Connect writes from short-lived SQLite writer contention. Use 100 ms native lock waits, followed by asynchronous exponential retries with jitter and an approximately five-second budget, replaying the whole atomic statement or IMMEDIATE transaction. Export ConnectStoreBusyError for exhaustion and classify the hub's additive 503 response contract as minor. Keep archive enrichment isolated, preserve safe inventory diagnostics, and return an exhausted report's operation and budget as HTTP 503 without its private cause. Preserve WAL, FULL synchronous mode and owner-only database and sidecar files; leave Work, Code and Fleet job settings unchanged. Optional archive passes on live directory reads stop at the first failure, limiting writer contention to one native wait for the whole fleet and invalidating absence evidence for skipped hosts. Parent-name and voice/self-state enrichment each have a 100 ms deadline. Directory and post-page reads filter retained rows without pruning. Post writes evict one global batch of at most 256 expired reports under the asynchronous write budget, including reports from agents that never write again, and trim only the writer to 128 entries. Physical expiry eviction waits for post writes; dormant fleets retain hidden expired rows until posting resumes. Equal-time observations cannot clear archive taint; recovery must be strictly newer. Optional failures remain isolated and logged, preserving the browser's directory deadline.

  Include transaction-permit queueing in the write deadline and retry SQLITE_LOCKED alongside SQLITE_BUSY. Preserve safe busy metadata for remote reporters, using the reporter timeout option on peer inventory reads while leaving ordinary directory deadlines unchanged. Stop a blocked-notification pass after its first store failure. New archive closure snapshots ignore expired reports, preserving the inclusive retention cutoff and existing recorded last words.

  Stop notification admission on subscription-store failures too, while draining already-reserved provider sends and recording their definite outcomes. Bound optional hue allocation to half the peer-directory deadline. Preserve typed busy responses in Relay post and self-state clients, without repeating an exhausted post or exposing the server-private cause.

  Request-facing hub stores use zero native lock waits and return typed failures immediately; Connect batch writers retain asynchronous retries. Export the shared report response deadline, derived from reporter inventory plus the primary write plus a transport margin, and use it in both report clients so exhausted busy responses arrive before cancellation.

  Serialize activity observations and optional hue allocations through one store-wide permit, including file-permission finalization. Preserve the existing queue-inclusive write and optional hue deadlines. Secure lazy WAL and SHM sidecars after post-page SELECTs without reintroducing read-path pruning.

  End the busy deadline after lock acquisition and SQL retries, before post-commit permission finalization. Keep the transaction permit through finalization without returning ConnectStoreBusyError for an already-committed write. Apply the same boundary to the optional hue lock budget.

## 0.23.0

### Minor Changes

- [#875](https://github.com/knpkv/npm/pull/875) [`5a8885c`](https://github.com/knpkv/npm/commit/5a8885c94067f1fcde10746ccc0bb2397333eaa6) Thanks [@konopkov](https://github.com/konopkov)! - Add explicit terminal takeover across devices. A controlled terminal offers Take over, including when all four controller slots are occupied; the previous device shows Taken over on another device with Reconnect. Keep Connecting during bounded cleanup and cancel pending admission when the stage closes. Preserve recovery-dialog focus through directory refreshes. Require fresh authenticated remote-host capability before forwarding takeover, preserving the controlled state on older hosts. Export optional takeover selection and the capability and takeover-close schemas.

  Ordinary reconnects wait for a closing controller's bounded release instead of being refused as already controlled. Live controllers remain exclusive; cancellation and newer takeovers retain the same cleanup barrier.

## 0.22.0

### Minor Changes

- [#872](https://github.com/knpkv/npm/pull/872) [`8f2d743`](https://github.com/knpkv/npm/commit/8f2d743cc568d386801ef115628567eb3497005c) Thanks [@konopkov](https://github.com/konopkov)! - Persist per-agent hue families, resolve live-host collisions with shape-aware overflow, and serve retained family snapshots in the archive.

## 0.21.0

### Minor Changes

- [#870](https://github.com/knpkv/npm/pull/870) [`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9) Thanks [@konopkov](https://github.com/konopkov)! - Add the Connect home descriptor and migrate hub destinations only when their source pages are retired and their replacement pages are installed. Connect stage, approval, Work and Usage selectors survive redirects, while the shell preserves foreign history state.

  Primary module links open their declared default page without resuming a previous object selection or filter. Module sections remain mounted while inactive; page-local state survives a page switch only when the pages render a shared owner component, as Fleet does.

  Add an optional discriminated Home presentation to ConnectSurface, with a host-owned summary above the directory. Fleet remains the default; directory reads, stage selection, pins and terminal callbacks keep one owner.

  Install Connect home as the canonical landing page, with flat installed-only sidebar and phone destinations, settings in More, and Fleet Approvals/Work through fleetHubModule. The standalone Fleet surface retains all four pages. Add typed primaryModules and optional FleetShell pages for canonical composition.

  Add Usage By tool from the existing reported host/tool/model data; unknown hosts never count as zero. Move the authenticated summary API to /v1/modules/connect/needs-you; the retired Today API returns 404. needsYouRouteOwner identifies the reserved collector route.

  Export one explicit Fleet/Home/push agent-group policy. Home includes Ready/Idle and truthful relationship labels, while Fleet's unknown-state fallback remains unchanged. Clearing filters in a hidden Connect owner no longer steals focus.

  Add optional agentStatePresentation policy and Creature statePolicy, defaulting to Fleet. Home's unknown agent has caution wording without a needs-you pose. Fleet host filtering matches host names case-insensitively, consistently with Home and selectors.

  Require SuperappShell session access and connection state from its composition. The footer distinguishes local/Tailscale access, retained readings while reconnecting, and an unreachable hub without claiming connected.

  Add ConnectSurface active (default true) for inactive embedded modules: release the stage portal and watched-agent presence while keeping saved selection, polls, pins and terminal/session ownership alive.

  Add the shell terminalOwnsKeys input so Connect Home retains Ask Relay summon keys until an active connected terminal reserves them; legacy Fleet Connect ownership is unchanged.

  Only the displayed Fleet limits footer owns its poll. Home performs no limits read; Fleet starts that read after the directory loads and the footer is shown, including its terminal presentation policy.

  Add optional ModuleViews.navigationBadge for owner-supplied bounded readings. Fleet uses its existing pending approvals, marks partial counts with a plus and stale counts as a previous reading, and shares expiry-aware counting with the app icon badge. Unknown readings have an accessible label without a visible zero badge. No unread notification count is claimed.

  The active Connect terminal keeps its existing full-screen layout, hides shell chrome from focus and accessibility, and restores the Home document scroll on return.

  Home's Done label uses the design's neutral shared check glyph through an additive AgentStateLabel statePolicy; Fleet retains its positive tone. Failed terminal focus transitions are announced with actionable words instead of internal reason codes.

  Add an optional Home empty-state slot and shell-owned openHostAccess mount callback. Empty Home links only to existing Fleet Work and Host access. Silent-host Home rows say Unknown with cached work and reported last-activity time; Fleet retains its last-known labels.

  Add an optional AgentStage presentation for Home navigation chrome. Phone Back and desktop Close use the existing selection close and focus-return path; Fleet's header and both stage bodies stay unchanged.

  Add optional module-page `showInPhoneTitle` metadata for designed phone mast labels.

  Connect Home retains Active/Archived navigation, including read-only closed stages and retained older-page recovery. The optional paired directoryLocation owns URL and navigation together; absent keeps standalone history unchanged. Embedded hub owners require that pair, build links from their saved Connect location and preserve shell/foreign history through the shell navigator. Inactive archive portals and expired-selection repair are suppressed while closure selection and loaded pages remain retained. Paging and retry transitions keep keyboard focus in the archive and move it to the new result or recovery control.

  The canonical Connect module forwards the dashboard notification state to its stage footer, avoiding a competing device-state read.

  Inactive Connect releases its document and viewport locks while retaining the terminal socket. Reactivation restores guarded terminal focus once. Leaving Active for Archived releases terminal ownership so shell chrome and summon keys recover. URL-selected stage close removes selectors through replace navigation without remounting the directory; a repeated incoming selection reopens it.

  Returning to a module keeps its owner's arrival focus, such as Work goal details. History traversal also preserves focus claimed inside the destination; explicit page-focus requests stay unchanged. URL-owned stages follow history selector changes and return focus to their agent row; local stages and filters remain owned by the retained directory.

  Empty Home keeps a compact Approvals unknown link when the independent approval reading is incomplete or failed. By tool retains its reported range during range updates and names failed retained readings with their timestamp and five-minute retry cadence.

  Controlled Connect locations also supply selection dismissal. Archived-stage Close consumes the shell-owned pushed entry, or replaces a direct/reloaded selection, so Back does not reopen it. Standalone history stays unchanged. Approval-count copy uses the singular noun for one waiting approval.

  Limit retry controls follow their owning Usage page. Home creature arrivals use Home's unknown-evidence policy, while Fleet keeps its safety fallback. Export normalized Connect URL-selection helpers shared by target resolution, retained terminal preference changes and stage ownership: unrelated query parameters or host-case changes keep the same terminal, and case-insensitive stage links clear their selectors on close.

### Patch Changes

- Updated dependencies [[`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9)]:
  - @knpkv/rly@0.23.0
  - @knpkv/agent-usage@0.10.4
  - @knpkv/herdr-work@0.12.2

## 0.20.2

### Patch Changes

- [#866](https://github.com/knpkv/npm/pull/866) [`9904bb8`](https://github.com/knpkv/npm/commit/9904bb8648a2bbc8275a2dbb65354648c44a429d) Thanks [@konopkov](https://github.com/konopkov)! - Stop archive reads after ten seconds with a typed timeout and Retry, without restarting the deadline on directory polls. Limit the directory's configured-host hint to the first 256 machines in configuration order so host metadata stays within the page schema's bound.

## 0.20.1

### Patch Changes

- [#864](https://github.com/knpkv/npm/pull/864) [`1823277`](https://github.com/knpkv/npm/commit/18232777eb388e16f75b2fed6b2445c1a4c10a71) Thanks [@konopkov](https://github.com/konopkov)! - Restore the Connect directory after a stable agent moves panes. A strictly newer trusted inventory observation can update its pane while preserving the same parent and relation, in the existing batch transaction. Keep stale, equal-time and durable observations from moving ownership, and log local inventory failures with only a step, validated agent ID and reason.

## 0.20.0

### Minor Changes

- [#853](https://github.com/knpkv/npm/pull/853) [`463a39f`](https://github.com/knpkv/npm/commit/463a39fac06cd41205b4733ccce9a1649c852093) Thanks [@konopkov](https://github.com/konopkov)! - Add the URL-addressable Archived directory with bounded paging, loaded-record search, read-only closure details and static closed creatures.

## 0.19.0

### Minor Changes

- [#852](https://github.com/knpkv/npm/pull/852) [`fd8fb68`](https://github.com/knpkv/npm/commit/fd8fb68c95cbb05ef206bf8e92683cc5f4023a71) Thanks [@konopkov](https://github.com/konopkov)! - Add stage notification controls for per-agent mutes and quiet hours in the user's time zone. Keep the last saved settings after failed changes and link devices with notifications off to Approvals. Let applications supply stage controls through the optional `ConnectSurface.stageFooter` prop. Render the muted notification status as one sentence matching the design.

  Replace full-snapshot `PUT /v1/push/blocked-settings` with atomic `PATCH` intents for one agent's mute or quiet hours, so a stale device cannot overwrite another device's preferences. Queue mute toggles and quiet-hour reversions against their latest intended values. Enter after a queued Clear saves the visible time pair as the final intent without duplicate saves. Save valid drafts on backdrop and Close dismissal while keeping Escape as cancel. Preserve keyboard focus while editing times, and show devices with stale subscription keys as off until Approvals reconciles them.

## 0.18.0

### Minor Changes

- [#858](https://github.com/knpkv/npm/pull/858) [`75cbd22`](https://github.com/knpkv/npm/commit/75cbd223d797c52021b0d13b0ef30b568379b289) Thanks [@konopkov](https://github.com/konopkov)! - Add optional configured `hosts` to fleet directory responses and `configuredHosts` to the directory view. Empty directories keep search and filters, and name configured hosts when supplied by the hub. Older responses remain supported without the hint.

  Remember missing parents' display names through optional relationship `parentName` and archive name lookup, without treating those names as live identity. Keep a lone orphan's alert inline, while siblings share one missing-parent notice. Retain typed unavailable readings in `ConnectLimitsView.problems` for limits warnings.

  Keep live directory rows available when archive name enrichment fails, with a warning in the server log. Keep disabled limits hidden after refresh failures, and identify an unavailable host when other host readings are present.

  Match directory recovery, empty filters, orphan groups and pinned agents to the current design. Use commas in directory copy, 48px HTTP recovery and clear-search controls, compact timeout and scoped filter controls with 44px hit areas, and sticky pins with reserved footer space that leaves agent rows and footer actions clear. Cap phone pin pills at 144px and truncate only names, keeping state words visible with 12px end padding. Give directory reads a typed ten-second deadline and distinguish actual timeouts from HTTP, network and decoding failures; omit the Usage link for a generic limits request failure. Match secondary metadata, regular body text and inset family dividers. Keep the limits footer hidden until the first directory loads, while preserving it with retained stale rows.

## 0.17.0

### Minor Changes

- [#859](https://github.com/knpkv/npm/pull/859) [`820b6b7`](https://github.com/knpkv/npm/commit/820b6b7c6dfbb7a6e4b25978233ec80d981ec7a5) Thanks [@konopkov](https://github.com/konopkov)! - Add agent-authored creature self-state to the authenticated directory, backed by the shared post database with partial updates, archive cleanup and rate limits. Add host-authorized relay me and the stdio relay_me MCP tool with shared current-pane resolution and transport.

## 0.16.0

### Minor Changes

- [#821](https://github.com/knpkv/npm/pull/821) [`9ffdbef`](https://github.com/knpkv/npm/commit/9ffdbef7fe8493d241580043cb5cad4521174423) Thanks [@konopkov](https://github.com/konopkov)! - Notify subscribed users when agents need attention, with durable episode deduplication, one reminder, visible-stage acknowledgement, per-agent mute and quiet hours in a validated IANA time zone. Add application-owned stage observation and a pure shared state-bucket helper to Connect.

- [#832](https://github.com/knpkv/npm/pull/832) [`9561de3`](https://github.com/knpkv/npm/commit/9561de3bcdc8cf21598087700dc742993d143cda) Thanks [@konopkov](https://github.com/konopkov)! - Report the text field, actual length and kind-specific limit when Relay posts are too long. CLI and HTTP validation share the same errors and reject empty or whitespace-only text while accepting URLs within the limit.

  Export shared Connect post text limits and reject blank text only in the published posting schemas. Historical whitespace-only reports and last words stay readable. Hub validation uses the published schemas as its authority.

### Patch Changes

- [#830](https://github.com/knpkv/npm/pull/830) [`96bd47e`](https://github.com/knpkv/npm/commit/96bd47eb282ec5b9321e980f693574406072d41d) Thanks [@konopkov](https://github.com/konopkov)! - Keep local blocked notifications available when peer discovery fails, deliver to up to four subscriptions concurrently while preserving each subscription's episode order, and avoid repeated stage reports when an inline callback changes identity.

- [#826](https://github.com/knpkv/npm/pull/826) [`1f5333d`](https://github.com/knpkv/npm/commit/1f5333d6b0aafb0baa5375c7659d7b26f1a3f180) Thanks [@konopkov](https://github.com/konopkov)! - Fill row and phone stage creature tracks, fit state rings around row bodies, retain a faint full ring beneath working arcs, and show healthy usage limits as secondary text with an arrow to Usage.

## 0.15.1

### Patch Changes

- Updated dependencies [[`2dc1b33`](https://github.com/knpkv/npm/commit/2dc1b33cf3c27ee2cc61e5476a6665e574a46792), [`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127), [`0fa3c3a`](https://github.com/knpkv/npm/commit/0fa3c3a81a4f1b30c43091f82a8ecdd68ddbfcd0)]:
  - @knpkv/agent-usage@0.10.0
  - @knpkv/bounded-io@0.3.0
  - @knpkv/rly@0.22.1
  - @knpkv/herdr-fleet@0.10.1

## 0.15.0

### Minor Changes

- [#808](https://github.com/knpkv/npm/pull/808) [`f5e574a`](https://github.com/knpkv/npm/commit/f5e574abb9dec49f205caeefad3d89400cdd9a0e) Thanks [@konopkov](https://github.com/konopkov)! - Register a read-only Usage details module with typed range, time-zone and host selectors. Keep legacy Fleet Usage destinations intact and reuse the hub's existing usage and limits reports.

  SuperappShell accepts an optional typed mobileModules list for the phone bar, with off-bar modules announced on All modules. ModulePageMount.navigate accepts an optional focus destination. Page focus remains the default; null keeps focus on an in-page selector while its URL is replaced.

  Expose the existing stateless UsageTab, browser report loaders, view-state helpers, loopback helpers and report/query types through herdr-connect's browser-safe usage entry. UsageTab's optional presentation selects Limits or Tokens beneath a host-supplied heading; its default Fleet markup and existing UsageSurface behaviour are unchanged. Reports carry no cost, balances, bookings, sessions, paths or prompt prefixes.

## 0.14.0

### Minor Changes

- [#803](https://github.com/knpkv/npm/pull/803) [`0dfab65`](https://github.com/knpkv/npm/commit/0dfab650505c01d94184831b34aa99cc5c957ce3) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded agent voice posts on the authenticated canonical hub, with host-bound live inventory checks, idempotent retries, paged retention, and archived last words. Add the relay post CLI.

### Patch Changes

- Updated dependencies [[`3c5bfb7`](https://github.com/knpkv/npm/commit/3c5bfb7fee6e8fb14fe64a28688be752a5cb60b9), [`3865413`](https://github.com/knpkv/npm/commit/3865413011482749e76c23bf8e1066b63b6ed5b8)]:
  - @knpkv/rly@0.22.0
  - @knpkv/agent-usage@0.9.3
  - @knpkv/herdr-work@0.12.1

## 0.13.0

### Minor Changes

- [#789](https://github.com/knpkv/npm/pull/789) [`bdabf68`](https://github.com/knpkv/npm/commit/bdabf6855cf008d5b08ca00de775895cbed0fcaa) Thanks [@konopkov](https://github.com/konopkov)! - Approvals show the requesting bot's Connect portrait when its exact identity is known, retain requests after failed reads, and revalidate stale decisions before sending them. The Connect surface exports AgentCreature for shared requester portraits.

  The request list and history follow the responsive Approvals layout. Full request disclosures can show JSON built from the same normalized fields as the default field view.

### Patch Changes

- Updated dependencies [[`57880bb`](https://github.com/knpkv/npm/commit/57880bbfb042d60bfed8a4465260e8b47c7e25c4), [`70f28c7`](https://github.com/knpkv/npm/commit/70f28c782bc8621513b9255e245533a7baa5d710)]:
  - @knpkv/herdr-work@0.12.0
  - @knpkv/rly@0.21.0
  - @knpkv/agent-usage@0.9.1

## 0.12.0

### Minor Changes

- [#764](https://github.com/knpkv/npm/pull/764) [`b08f713`](https://github.com/knpkv/npm/commit/b08f713a08f44c11a0f90528996faf162e7a96c6) Thanks [@konopkov](https://github.com/konopkov)! - Retain compact closed-agent records after two complete host reads confirm at least five minutes of absence. Expose bounded archive pages through the authenticated hub listener and remove records when the same agent returns. Older peers remain visible but supply no closure evidence until they report complete inventories. Failed writes restart that host's closure grace period after recovery; restarting the store requires fresh absence evidence and retains existing archive records.

- [#767](https://github.com/knpkv/npm/pull/767) [`241c5c7`](https://github.com/knpkv/npm/commit/241c5c7af802fb427fca1ac4e40a86151b8527f0) Thanks [@konopkov](https://github.com/konopkov)! - Group agents by recorded family, keep filtered ancestry visible, and show lineage and owned pull requests on the stage. Compact the phone directory and its filters; creatures carry row state with accessible words and forced-colour glyphs.

  Match the Connect design with an attention heading, one-column outlined families, inline activity times and shared missing-primary groups. A bad lineage edge no longer blanks the directory: each issue is labelled, while duplicate own identities alone cannot open a stage or terminal.

- [#752](https://github.com/knpkv/npm/pull/752) [`20cb874`](https://github.com/knpkv/npm/commit/20cb8746e9b9519b3a0dc371ec654c79a874df95) Thanks [@konopkov](https://github.com/konopkov)! - Connect pins more than one agent. Each pin is its own chip, in the order you pinned them, with its own unpin button; Delete or Backspace on a focused chip unpins it too. Over the directory the chips stack in the corner, clear of the phone's safe area; in the terminal they sit in its bar as characters only, or on a phone behind a single "Pins N" button, so the bar never takes a line from the terminal and never covers the output. Past three chips (two in the terminal's bar) the rest wait behind a "+N" button, and a pinned agent that has left the directory shows there, dimmed, with when it was last seen, so a pin never disappears. Up to eight agents can be pinned; pinning a ninth asks you to unpin one first. A pin saved by the earlier single-pin version carries over and says it hasn't been seen until a poll lists its agent.

- [#779](https://github.com/knpkv/npm/pull/779) [`05281e2`](https://github.com/knpkv/npm/commit/05281e2b90cd59c4373cb6e5aa79dcb8242c49a9) Thanks [@konopkov](https://github.com/konopkov)! - Add a one-shot Shift modifier to the terminal key rail. Shift+Tab cycles modes, shifted arrows preserve their modifiers, Shift+Enter inserts a newline with CSI-u, and Shift uppercases a typed letter. Shift combines with Ctrl or Alt; existing Ctrl and Alt sequences stay unchanged.

- [#772](https://github.com/knpkv/npm/pull/772) [`a947727`](https://github.com/knpkv/npm/commit/a9477277535a0543caf5d70babc41acda60ee315) Thanks [@konopkov](https://github.com/konopkov)! - Export the reusable Connect UI components from the browser-safe surface entry.

- [#771](https://github.com/knpkv/npm/pull/771) [`27bd371`](https://github.com/knpkv/npm/commit/27bd3714a526256705da5147872a0e7b68dae8c5) Thanks [@konopkov](https://github.com/konopkov)! - Expose the dashboard, activity, approval, refresh, and conversation UI through the public API.
  Expose the character, agent stage, pinned agents, limits, and usage UI through the public API.

- [#769](https://github.com/knpkv/npm/pull/769) [`09eb563`](https://github.com/knpkv/npm/commit/09eb56339ed68e9ac6c420947e9f617c4aa6a36d) Thanks [@konopkov](https://github.com/konopkov)! - Add seeded tapered brows to agent creatures, with state expressions, synchronized glance motion, static reduced motion, and opaque forced-colour rendering.

- [#754](https://github.com/knpkv/npm/pull/754) [`5013de5`](https://github.com/knpkv/npm/commit/5013de5bee7f341bc11d86ef3194eb8a37912777) Thanks [@konopkov](https://github.com/konopkov)! - Work and Connect link both ways. A Work goal's "Open <agent> in Connect" link now opens that agent's stage in Connect, its terminal one tap away; a Connect link with `open=stage` opens the stage, and links without it still open the terminal. An agent's stage links back to its Work goal when the board has exactly one.

### Patch Changes

- [#762](https://github.com/knpkv/npm/pull/762) [`29c8bc1`](https://github.com/knpkv/npm/commit/29c8bc1212de8592f30462a0e86280a05afcf27b) Thanks [@konopkov](https://github.com/konopkov)! - Connect in the hub uses a phone's full width. On screens up to 40rem the hub shell keeps one 16px gutter instead of 32px, and the embedded Connect panel adds none of its own, so an agent's row spans the screen less 32px. The Status options keep to one line whatever their counts, scrolling sideways rather than wrapping; host names still wrap so a long one stays readable.
- Updated dependencies [[`d3530ad`](https://github.com/knpkv/npm/commit/d3530ad9473b768a637603dc6ad023ca05347373), [`6644cb7`](https://github.com/knpkv/npm/commit/6644cb74218d7daf7f618f1da69dc30e4aa3d93a), [`4ebe301`](https://github.com/knpkv/npm/commit/4ebe30154220bff53ec507a0d70c5f8f4a543c5a), [`3ba4e78`](https://github.com/knpkv/npm/commit/3ba4e78663b026f101f929ef41294a48b6bafc5a), [`bd86c66`](https://github.com/knpkv/npm/commit/bd86c6696678b8c5469727d646096381406f1179), [`5013de5`](https://github.com/knpkv/npm/commit/5013de5bee7f341bc11d86ef3194eb8a37912777), [`8017b49`](https://github.com/knpkv/npm/commit/8017b490395ea15e3949b946ebe8f5313b5d165b)]:
  - @knpkv/agent-usage@0.9.0
  - @knpkv/rly@0.20.0
  - @knpkv/herdr-fleet@0.10.0
  - @knpkv/herdr-work@0.11.0

## 0.11.1

### Patch Changes

- [#749](https://github.com/knpkv/npm/pull/749) [`928f3e2`](https://github.com/knpkv/npm/commit/928f3e2f70fc7dc3074502b0558f55b178ce475f) Thanks [@konopkov](https://github.com/konopkov)! - Connect's characters keep their shape when they move: only the body squashes and stretches, keeping its area, and the face rides along without stretching. Eyes sit in shallow sockets with a lit iris, pupil and glints, look round without leaving the eye, and blink with lids that close onto the body's own skin. Outlines stand upright on a flat base, every combination of host and ID stays within one size, and the face's proportions stay in a range that never looks broken.

  A long agent name in the cast now ends in an ellipsis instead of spreading over its neighbours.

  The stage no longer shows a sideways scrollbar for the light field drifting past its edges.

- [#753](https://github.com/knpkv/npm/pull/753) [`99cf00e`](https://github.com/knpkv/npm/commit/99cf00e9738d3c617ad6c95dc5076ca18767f77e) Thanks [@konopkov](https://github.com/konopkov)! - Connect uses an iPhone's full width. Rows switch to the phone layout at 640px instead of 384px, so on every iPhone the state sits over the name and the name and work get the whole row instead of a 162px column. The Host and Status options take the full width, so the status words fit one line, and the stage keeps the page's 16px gutter.

## 0.11.0

### Minor Changes

- [#732](https://github.com/knpkv/npm/pull/732) [`86b917c`](https://github.com/knpkv/npm/commit/86b917c379041a6b90a6834e33a1ea7fd9668900) Thanks [@konopkov](https://github.com/konopkov)! - Every agent in Connect's directory gets a character: a soft creature drawn from its host and stable ID, so it looks the same everywhere. Its state only changes how it behaves — reading while working, turned toward you with a halo when it needs you, settled when done, eyes closed and still while the directory can't refresh. Motion runs only when the reader allows it (the system preference and the in-app reduced-motion setting), and forced colours draw it as an outline.

- [#738](https://github.com/knpkv/npm/pull/738) [`2413daa`](https://github.com/knpkv/npm/commit/2413daaa479f20d1eceb3388213549f3fbc7628c) Thanks [@konopkov](https://github.com/konopkov)! - Connect's characters live across polls. A creature turns to you once when its agent starts needing you, not on every poll and not on load. Rows keep their creature when another agent joins ahead of them, so its breath and blink carry on. An agent's stage lists the agents it started as named buttons that open their own stages, and its field drifts behind the character with a little parallax, only when the reader allows motion.

- [#740](https://github.com/knpkv/npm/pull/740) [`f2da944`](https://github.com/knpkv/npm/commit/f2da944253cfce068e2746324700f1ba68a2f047) Thanks [@konopkov](https://github.com/konopkov)! - Pin an agent from its stage and it stays to hand on this device: a small chip with its character, name and state floats in the directory's corner and opens its stage; in the terminal it sits in the bar, never over the output or the key rail. The pin survives a reload; storage that can't be written says so and keeps the pin until you reload.

- [#734](https://github.com/knpkv/npm/pull/734) [`e31ec38`](https://github.com/knpkv/npm/commit/e31ec38d3547fd92b977f630e7e048a473393b22) Thanks [@konopkov](https://github.com/konopkov)! - Connect gains a cast and a stage. A swipeable strip of every agent's character sits above the directory, the ones that need you first. A row or cast member opens the agent's stage: the character large on a field in its own hues, its work as what it is saying, its state and host, and Open terminal. Escape or Close returns focus to whatever opened it. The terminal now opens from the stage rather than straight from the row.

- [#718](https://github.com/knpkv/npm/pull/718) [`58dca5f`](https://github.com/knpkv/npm/commit/58dca5f56a7870ca059538e8a96209192fb3de9c) Thanks [@konopkov](https://github.com/konopkov)! - The hub serves usage history for the Usage tab. hostd answers `GET /v1/connect/usage?range=24h|7d|30d&timeZone=<zone>` with each host's `agent-usage usage` read, which holds tokens per period, agent and model, and the limit series. It derives that command from the existing `agentUsageLimitsCommand`. On the hub the answer includes every peer's read, from the peer's tailnet `/v1/connect/usage/local`. A bad range or zone is refused with 400 before anything runs, and reads are cached per range and zone for five minutes. herdr-connect exports the `FleetUsage` schemas, a tolerant decoder that skips token cells and limit series from a newer agent-usage and counts them, and `hubUsage`/`fleetUsage`. Limits and usage now share one fan-out helper.

  A host that cannot read its limits or usage now reports one of a fixed set of sentences ("agent-usage is not running on this host", "older version", "control socket could not be used"). agent-usage's stderr and spawn errors can name host paths, so they are logged on the host and no longer sent across the tailnet. This fixes the same leak in limits, present since [#698](https://github.com/knpkv/npm/issues/698). The hub waits 25 seconds for a peer's usage, longer than a cold 30-day read. Concurrent first asks for a range and zone share one read, and at most two reads run at once.

- [#722](https://github.com/knpkv/npm/pull/722) [`202ec0d`](https://github.com/knpkv/npm/commit/202ec0d1161718d8cb0974c50194241097aab88a) Thanks [@konopkov](https://github.com/konopkov)! - The hub has a Usage tab beside Approvals, Connect and Work (`g` then `u`, `?tab=usage`). It shows each host's "Limits now" cards, the fleet's tokens per day or hour stacked by agent and model, and each host's limits over the range, with a 24h/7d/30d switch on every screen size that defaults to 7 days and is remembered in the browser. On the hub's own machine it links to agent-usage's full page. Connect keeps its one-line limits strip, which now links to the Usage tab instead of opening the per-host cards. herdr-connect exports the tab as `@knpkv/herdr-connect/usage` (`UsageSurface`, `makeUsageAtoms`). The hub now passes on a peer's unavailable detail only when it is one of hostd's fixed sentences, so an older peer cannot relay raw agent-usage stderr through it.

### Patch Changes

- [#737](https://github.com/knpkv/npm/pull/737) [`6fddeab`](https://github.com/knpkv/npm/commit/6fddeab63340c81223691a3a1e96f53e2dbabcd1) Thanks [@konopkov](https://github.com/konopkov)! - A large Work board never hides goals silently. The Work tab says "N older goals not shown" for a window the board cut, and `fleetctl work snapshot` prints the same per window on stderr, keeping stdout the snapshot alone. Snapshots now carry `version: 1`. Readers accept any version and ignore keys they don't know; when a newer format no longer decodes, fleetctl says "upgrade fleetctl with the hub" and the hub page says "reload the page" instead of reporting a malformed snapshot. A fleetctl from before this release still decodes strictly and fails against a hub that cut its board, so upgrade fleetctl with the hub; hosts updated together through nix are unaffected.
- Updated dependencies [[`202ec0d`](https://github.com/knpkv/npm/commit/202ec0d1161718d8cb0974c50194241097aab88a), [`e7b8f1a`](https://github.com/knpkv/npm/commit/e7b8f1ab3d85fa47821246c4d034247150ab43ce), [`ea0c0ed`](https://github.com/knpkv/npm/commit/ea0c0ed700cb69dd86e56fba425dd16d9869a577), [`c951532`](https://github.com/knpkv/npm/commit/c951532eef3faa2d756339060be2ce774f904c03), [`6fddeab`](https://github.com/knpkv/npm/commit/6fddeab63340c81223691a3a1e96f53e2dbabcd1)]:
  - @knpkv/agent-usage@0.8.1
  - @knpkv/herdr-work@0.10.0
  - @knpkv/rly@0.19.0

## 0.10.2

### Patch Changes

- Updated dependencies [[`b107010`](https://github.com/knpkv/npm/commit/b107010b57d13a6d4d5552e736a10e64f1367985), [`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4), [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84), [`eb2ddfd`](https://github.com/knpkv/npm/commit/eb2ddfd124b3e8805d886fa26c178aa59231f1b4)]:
  - @knpkv/agent-usage@0.8.0
  - @knpkv/rly@0.18.0
  - @knpkv/herdr-work@0.9.5

## 0.10.1

### Patch Changes

- Updated dependencies [[`a21684e`](https://github.com/knpkv/npm/commit/a21684e5ede609b9bf2b08d683e9b6c8efc04272)]:
  - @knpkv/agent-usage@0.7.0

## 0.10.0

### Minor Changes

- [#704](https://github.com/knpkv/npm/pull/704) [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b) Thanks [@konopkov](https://github.com/konopkov)! - Connect shows Claude and Codex limits. A line under the summary names each agent's window closest to its limit ("Claude 86% 5-hour", "Codex unknown"), and a disclosure holds each host's "Limits now" cards from agent-usage. agent-usage's `LimitsSummary` takes an optional `title`, and gives each instance its own heading id.

- [#698](https://github.com/knpkv/npm/pull/698) [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133) Thanks [@konopkov](https://github.com/konopkov)! - hostd serves Claude and Codex limits for Connect. Set the optional `agentUsageLimitsCommand` in the fleet configuration to `agent-usage limits`. `GET /v1/connect/limits` then returns this host's read, and on the hub every peer's read too. herdr-connect exports the wire schemas (`HostLimits`, `FleetLimits`) and the fleet collection. A host that can't read its limits says why instead of reporting zero.

### Patch Changes

- [#690](https://github.com/knpkv/npm/pull/690) [`7e38bea`](https://github.com/knpkv/npm/commit/7e38beabe14c07ec27adc9391f2a25d502e87491) Thanks [@konopkov](https://github.com/konopkov)! - Fleet connect no longer locks zoom on phones: pinch zoom works again, and the search field and the terminal's text input stay at 16px so focusing them doesn't zoom the page on iOS.

- [#691](https://github.com/knpkv/npm/pull/691) [`eee2128`](https://github.com/knpkv/npm/commit/eee21285ba0a8364cb47cc90ec5b1dd9bf2c8aab) Thanks [@konopkov](https://github.com/konopkov)! - On touch screens a tapped terminal key, agent row or link no longer keeps its hover look; a tapped key could look like a latched modifier.
- Updated dependencies [[`1f6cc4a`](https://github.com/knpkv/npm/commit/1f6cc4ae3e3302681ad52fd667515f13cbfbeb40), [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b), [`d19931f`](https://github.com/knpkv/npm/commit/d19931f8abbdf82ca154f0be10d74c58b8d09f64), [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b), [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133), [`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f), [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96), [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10), [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f), [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44)]:
  - @knpkv/agent-usage@0.6.0
  - @knpkv/herdr-fleet@0.9.0
  - @knpkv/rly@0.17.0
  - @knpkv/herdr-work@0.9.4

## 0.9.0

### Minor Changes

- [#652](https://github.com/knpkv/npm/pull/652) [`2b79b24`](https://github.com/knpkv/npm/commit/2b79b241a95d5e6d54c1055e0b245bd24a490276) Thanks [@konopkov](https://github.com/konopkov)! - Connect's agents now speak the hub's state language. Each directory row shows the agent's state as an icon and word in its tone, the same label the hub's Agent activity uses, instead of a plain capitalised word. Only working agents spin, and only with motion allowed. `waiting` now counts under the Status filter's "Needs you" (renamed from "Attention") rather than "Ready", because it waits on a person. The work line no longer repeats the state ("Root agent, npm", not "Root agent, Working in npm"), since the label beside it says it. Unknown states keep their own word with a caution alert icon, so they never look idle. `@knpkv/herdr-connect/surface` exports `agentStatePresentation`, `AgentStateLabel`, `agentBuckets` and `agentBucketLabel`. herdr-approvals' Agent activity reads the same mapping, so its state words are now capitalised and blocked and errored agents show in critical tone.

- [#658](https://github.com/knpkv/npm/pull/658) [`504148b`](https://github.com/knpkv/npm/commit/504148b49fef69471bd3772c60d1629758ccf930) Thanks [@konopkov](https://github.com/konopkov)! - Connect is now the hub's one agent list, and the Work tab no longer repeats agents under Agent activity. Each Connect row leads with the agent's state (icon and word) in a fixed column, then its name and work, then when it was last active. Lineage indents the name, not the state. At 24rem and below the state sits above the name. A row's accessible name is its own content plus "open terminal". Status filter options show their counts within the current Host filter, ignoring the search. A host that didn't answer is named in the Host filter (not offered as an option) and, once, in a line above the list with its cause; the summary only counts agents: "GAMMA (timed out) didn't answer; its agents aren't listed." That line now shows on phones too. The directory shows when it was last read ("Updated 09:41:05"), changing only when a poll lands, and says "Stale" when a refresh failed. Empty and failure states read "No agents running on any host." and "The fleet directory didn't answer: …". `AgentDirectory` takes an optional `silentHosts`.

- [#664](https://github.com/knpkv/npm/pull/664) [`5199a49`](https://github.com/knpkv/npm/commit/5199a4959d643d029a9b7701bce94d904250abfd) Thanks [@konopkov](https://github.com/konopkov)! - Connect's key rail has a Keyboard button: press it to bring up the on-screen keyboard (it focuses the terminal's input inside the tap, so iOS opens it), press again to put it away. It stays pressed while the keyboard is up, including after a tap on the terminal. On a phone the "N lines back" status is now a badge over the terminal's top corner rather than a rail cell, so it never resizes the terminal and taps go through it. `TerminalKeyRail` takes optional `keyboardOpen` and `onKeyboardToggle`.

- [#670](https://github.com/knpkv/npm/pull/670) [`8acdf0d`](https://github.com/knpkv/npm/commit/8acdf0dbd0800c27d5dd4d0130e035558f575975) Thanks [@konopkov](https://github.com/konopkov)! - Connect's key rail has a Paste button. It reads the clipboard inside the tap (iOS asks to confirm) and sends the text to the terminal as one paste, bracketed when the program asked for it; a latched Ctrl or Alt is released first. An empty clipboard, a refused read or a browser without clipboard access says so in the rail. On phones the pinned actions sit five to a row. `TerminalKeyRail` takes an optional `onPaste`.

### Patch Changes

- Updated dependencies [[`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/rly@0.16.0
  - @knpkv/herdr-work@0.9.3

## 0.8.0

### Minor Changes

- [#649](https://github.com/knpkv/npm/pull/649) [`132d46b`](https://github.com/knpkv/npm/commit/132d46bc0ed8a881737a0ead6db9b32cbbac4889) Thanks [@konopkov](https://github.com/konopkov)! - In Connect on iPhone, a tap on the terminal now brings up the keyboard: it focuses the terminal's text input inside the tap, where Ghostty's own focus went to a container iOS won't type into. The key rail gets a Keys toggle that hides the Ctrl/Alt modifiers and the terminal keys (Select and Latest stay), remembered on this device. `TerminalKeyRail` takes optional `keysHidden` and `onKeysHiddenChange`.

### Patch Changes

- [#653](https://github.com/knpkv/npm/pull/653) [`5594373`](https://github.com/knpkv/npm/commit/5594373fe3479fa7cbae68608f8b7b84606407e6) Thanks [@konopkov](https://github.com/konopkov)! - On a phone the terminal key rail no longer grows a row when "N lines back" appears, so the terminal keeps its size while you scroll and page-sized scrolls match the screen. With the new Keys button the status pushed Select onto a fourth row; it now takes one column beside Keys, Latest and Select.
- Updated dependencies [[`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/rly@0.15.0
  - @knpkv/herdr-work@0.9.2

## 0.7.4

### Patch Changes

- [#623](https://github.com/knpkv/npm/pull/623) [`c47e854`](https://github.com/knpkv/npm/commit/c47e8544c762aeb58a28811106e3acf768af12b1) Thanks [@konopkov](https://github.com/konopkov)! - The hub no longer jumps while its first content loads. Connect's agent directory and the Work board each hold a screen of space until their first content arrives, through a failed first request and its retry, so the coordinator chat (Connect) and the agents and history panels (Work) stay out of view instead of being pushed down when the list or board arrives. CLS on a cold load was 0.60 (Connect, 768) and 0.48 (Work, 1440).
- Updated dependencies [[`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d), [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/herdr-fleet@0.8.0
  - @knpkv/rly@0.14.0
  - @knpkv/herdr-work@0.9.1

## 0.7.3

### Patch Changes

- [#594](https://github.com/knpkv/npm/pull/594) [`16244c5`](https://github.com/knpkv/npm/commit/16244c58b41cd8dcee799fd8e8e058598df3fb90) Thanks [@konopkov](https://github.com/konopkov)! - When a terminal session ends and herdr does not take the release command, does not exit, or cannot be killed afterwards, Connect now logs a warning for each instead of dropping the failure silently. Cleanup still never fails the session.
- Updated dependencies [[`0d6cc4d`](https://github.com/knpkv/npm/commit/0d6cc4df23eca64c5d29725bf50899776cc52435), [`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/herdr-work@0.9.0
  - @knpkv/rly@0.13.0

## 0.7.2

### Patch Changes

- Updated dependencies [[`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26), [`bfba87c`](https://github.com/knpkv/npm/commit/bfba87c566ca21d267c0626da60b431757dc5e32)]:
  - @knpkv/herdr-fleet@0.7.0
  - @knpkv/herdr-work@0.8.1

## 0.7.1

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.

- [#586](https://github.com/knpkv/npm/pull/586) [`1ef72d9`](https://github.com/knpkv/npm/commit/1ef72d9317a37e8f28563cae113e9908d8242c3a) Thanks [@konopkov](https://github.com/konopkov)! - The herdr-connect test suite, browser fixtures included, is now typechecked as part of `check`, and the package leaves the test-typecheck allowlist.
- Updated dependencies [[`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa), [`f8e842e`](https://github.com/knpkv/npm/commit/f8e842e901986b50edf55f98fa3591b742a7904e), [`30849c5`](https://github.com/knpkv/npm/commit/30849c598fdf6776a3a4a2c4061d276e843eaa8e)]:
  - @knpkv/rly@0.12.1
  - @knpkv/herdr-work@0.8.0

## 0.7.0

### Minor Changes

- [#548](https://github.com/knpkv/npm/pull/548) [`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1) Thanks [@konopkov](https://github.com/konopkov)! - Connect knows where a terminal is really scrolled to. The hub reads herdr's scroll position for the open pane (at most twice a second per session and ten times a second across the host) and sends it to the browser, so a pane someone left scrolled back opens with "Older output, N lines back", and Latest returns in exactly that many lines, one command per frame, until a fresh reading says the pane is at the bottom. Readings are taken only while no scroll is in flight and carry the number of scrolls they cover, so the browser uses only those that already include every scroll it sent. Hosts send it only to clients that ask for it, so hubs and hosts can be upgraded in any order. When the position can't be read it is shown as unknown, never as the bottom, and Connect falls back to its previous behaviour.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
- Updated dependencies [[`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c), [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/herdr-work@0.7.2
  - @knpkv/rly@0.12.0

## 0.6.0

### Minor Changes

- [#557](https://github.com/knpkv/npm/pull/557) [`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb) Thanks [@konopkov](https://github.com/konopkov)! - The Connect tab leads with one sentence ("19 agents live, 1 needs attention; GAMMA offline") under a plain page title, instead of a display headline, an eyebrow and a count chip. Host and status filters are words with the current one underlined, each a full-height target. Rows show the agent's state as a word (ink only when it needs attention) without presence dots or status chips, name a parent agent by its name instead of its full id, keep host and work names whole, and wrap long lines instead of cutting them off; the selected row is filled and outlined rather than marked by a side bar. A directory that fails to load or refresh says why in one line and keeps the last list with its age, never a stack trace.

### Patch Changes

- Updated dependencies [[`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/rly@0.11.0
  - @knpkv/herdr-work@0.7.1

## 0.5.0

### Minor Changes

- [#537](https://github.com/knpkv/npm/pull/537) [`d183858`](https://github.com/knpkv/npm/commit/d1838583e51cd683e167d6cb735ebbfe552bdb7f) Thanks [@konopkov](https://github.com/konopkov)! - Connect terminal: copy text, open links, and scroll like a native list on touch. Selecting with the mouse no longer writes the clipboard on its own: Cmd/Ctrl+C copies the selection and only sends ^C when nothing is selected, and triple-click selects a whole line. Cmd/Ctrl+click (or a tap on touch) opens http and https links in a new tab, and other schemes are never opened. On touch, the terminal follows the finger 1:1 and keeps moving after a flick, scrolling no longer brings up the keyboard, a long-press or the Select key shows the screen as selectable text with Copy buttons, and a Latest key always returns to the newest output, with an "Older output" note while you are known to be scrolled back.

### Patch Changes

- [#549](https://github.com/knpkv/npm/pull/549) [`21ab62a`](https://github.com/knpkv/npm/commit/21ab62a25400f61f27a5230553e4d4780034b899) Thanks [@konopkov](https://github.com/konopkov)! - Connect writes its status lines as phrases instead of joining facts with middots: "codex on SER8", "Work goal: …", "No Work goal linked", "Terminal focus transition failed: …". The middot ast-grep rule now covers Connect too.
- Updated dependencies [[`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8), [`d266e4c`](https://github.com/knpkv/npm/commit/d266e4cccb601e0d8006ce50e48743b8f347f21e), [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/herdr-fleet@0.6.1
  - @knpkv/herdr-work@0.7.0
  - @knpkv/rly@0.10.0

## 0.4.5

### Patch Changes

- [#516](https://github.com/knpkv/npm/pull/516) [`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9) Thanks [@konopkov](https://github.com/konopkov)! - Connect ignores an abandoned goal's ownership the same way it ignores a completed one.
- Updated dependencies [[`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f), [`18d5c8b`](https://github.com/knpkv/npm/commit/18d5c8b1bead309094021b0b54fb9d49b83fc50a), [`c037ee6`](https://github.com/knpkv/npm/commit/c037ee6bffca3178d82c5d29a3f203de26db146e), [`b0b385c`](https://github.com/knpkv/npm/commit/b0b385cbfa570e19dd4fa81cd553d3aaf957361f), [`8d051cb`](https://github.com/knpkv/npm/commit/8d051cb05a9b22d59d348346e1f45897fec187b3), [`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9), [`aac9574`](https://github.com/knpkv/npm/commit/aac9574b6614cdf1f2be74d641c9a191b7e8c903)]:
  - @knpkv/rly@0.9.0
  - @knpkv/herdr-fleet@0.6.0
  - @knpkv/herdr-work@0.6.0

## 0.4.4

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d), [`8363bd4`](https://github.com/knpkv/npm/commit/8363bd4dd5fc6df3b15ae70132c080bd52d19a0f)]:
  - @knpkv/rly@0.8.0
  - @knpkv/herdr-work@0.5.3

## 0.4.3

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0
  - @knpkv/herdr-work@0.5.2

## 0.4.2

### Patch Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/bounded-io@0.2.0
  - @knpkv/herdr-fleet@0.5.1

## 0.4.1

### Patch Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
- Updated dependencies [[`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e)]:
  - @knpkv/herdr-fleet@0.5.0
  - @knpkv/herdr-work@0.5.1

## 0.4.0

### Minor Changes

- [#412](https://github.com/knpkv/npm/pull/412) [`17df0ad`](https://github.com/knpkv/npm/commit/17df0ad67dcf339d0d9541656be1ce236c3e34a2) Thanks [@konopkov](https://github.com/konopkov)! - Add an accessible terminal special-key rail with safe one-shot Ctrl and Alt controls.

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#423](https://github.com/knpkv/npm/pull/423) [`a7db83b`](https://github.com/knpkv/npm/commit/a7db83b401fbe08a6a05d2500ec020cd6d03c8e6) Thanks [@konopkov](https://github.com/konopkov)! - Keep embedded mobile terminals below Fleet navigation, restore focus safely when entering and leaving terminals, and expose every host and status filter on narrow screens.

### Patch Changes

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#444](https://github.com/knpkv/npm/pull/444) [`2f51fbb`](https://github.com/knpkv/npm/commit/2f51fbb893a6440ecd5cabf6b73bb52131395bc3) Thanks [@konopkov](https://github.com/konopkov)! - Keep the terminal connected when a mobile keyboard shrinks it below the server minimum size.

- [#427](https://github.com/knpkv/npm/pull/427) [`de01905`](https://github.com/knpkv/npm/commit/de0190543c6b030f8616f68d78192cb65cc98899) Thanks [@konopkov](https://github.com/konopkov)! - Lock document scrolling while an agent terminal is open and restore the prior page position and inline styles when it closes.
- Updated dependencies [[`c2da700`](https://github.com/knpkv/npm/commit/c2da70083bc4f8e82f9c6bd3dc2541e131585a5c), [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277), [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`2cb8964`](https://github.com/knpkv/npm/commit/2cb8964f9427e938c9aa75a3d401908884482d38), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59), [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401), [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069)]:
  - @knpkv/herdr-work@0.5.0
  - @knpkv/rly@0.6.0
  - @knpkv/herdr-fleet@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2), [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364)]:
  - @knpkv/herdr-fleet@0.3.0
  - @knpkv/rly@0.5.1

## 0.3.0

### Minor Changes

- [#398](https://github.com/knpkv/npm/pull/398) [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5) Thanks [@konopkov](https://github.com/konopkov)! - Add stable form identities for the Work activity search and Connect terminal inputs.

### Patch Changes

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Bound terminal control teardown to one release watchdog and an immediate kill.
- Updated dependencies [[`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/rly@0.5.0

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.

- [#386](https://github.com/knpkv/npm/pull/386) [`3d72330`](https://github.com/knpkv/npm/commit/3d72330d69ce0309436c470d8ba4557c7bfa6edf) Thanks [@konopkov](https://github.com/konopkov)! - Keep the mobile agent directory visible and fit connected terminals above the iPhone virtual keyboard.

### Patch Changes

- Updated dependencies [[`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2)]:
  - @knpkv/herdr-fleet@0.2.0
  - @knpkv/rly@0.4.1
