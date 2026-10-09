# @knpkv/herdr-approvals

## 0.15.0

### Minor Changes

- [#698](https://github.com/knpkv/npm/pull/698) [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133) Thanks [@konopkov](https://github.com/konopkov)! - hostd serves Claude and Codex limits for Connect. Set the optional `agentUsageLimitsCommand` in the fleet configuration to `agent-usage limits`. `GET /v1/connect/limits` then returns this host's read, and on the hub every peer's read too. herdr-connect exports the wire schemas (`HostLimits`, `FleetLimits`) and the fleet collection. A host that can't read its limits says why instead of reporting zero.

### Patch Changes

- [#690](https://github.com/knpkv/npm/pull/690) [`7e38bea`](https://github.com/knpkv/npm/commit/7e38beabe14c07ec27adc9391f2a25d502e87491) Thanks [@konopkov](https://github.com/konopkov)! - Fleet connect no longer locks zoom on phones: pinch zoom works again, and the search field and the terminal's text input stay at 16px so focusing them doesn't zoom the page on iOS.

- [#666](https://github.com/knpkv/npm/pull/666) [`5b79b06`](https://github.com/knpkv/npm/commit/5b79b06f381232b284f77b3c533c334ede7782b3) Thanks [@konopkov](https://github.com/konopkov)! - Hub CSS follows good-css: hover highlights only on devices that hover, 44px touch targets for the nav and activity filters, a 16px activity search so iOS doesn't zoom, small-viewport heights, `overflow: clip`, and opt-in motion. The activity toolbar now sticks while the history scrolls.

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.
- Updated dependencies [[`7e38bea`](https://github.com/knpkv/npm/commit/7e38beabe14c07ec27adc9391f2a25d502e87491), [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b), [`eee2128`](https://github.com/knpkv/npm/commit/eee21285ba0a8364cb47cc90ec5b1dd9bf2c8aab), [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133), [`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f), [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96), [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10), [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f), [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44)]:
  - @knpkv/herdr-connect@0.10.0
  - @knpkv/herdr-fleet@0.9.0
  - @knpkv/rly@0.17.0
  - @knpkv/herdr-coordinator@0.3.8
  - @knpkv/herdr-work@0.9.4

## 0.14.0

### Minor Changes

- [#658](https://github.com/knpkv/npm/pull/658) [`504148b`](https://github.com/knpkv/npm/commit/504148b49fef69471bd3772c60d1629758ccf930) Thanks [@konopkov](https://github.com/konopkov)! - Connect is now the hub's one agent list, and the Work tab no longer repeats agents under Agent activity. Each Connect row leads with the agent's state (icon and word) in a fixed column, then its name and work, then when it was last active. Lineage indents the name, not the state. At 24rem and below the state sits above the name. A row's accessible name is its own content plus "open terminal". Status filter options show their counts within the current Host filter, ignoring the search. A host that didn't answer is named in the Host filter (not offered as an option) and, once, in a line above the list with its cause; the summary only counts agents: "GAMMA (timed out) didn't answer; its agents aren't listed." That line now shows on phones too. The directory shows when it was last read ("Updated 09:41:05"), changing only when a poll lands, and says "Stale" when a refresh failed. Empty and failure states read "No agents running on any host." and "The fleet directory didn't answer: …". `AgentDirectory` takes an optional `silentHosts`.

- [#660](https://github.com/knpkv/npm/pull/660) [`ba0d5ba`](https://github.com/knpkv/npm/commit/ba0d5ba68b20b947eb08892b0c94b63347eae78e) Thanks [@konopkov](https://github.com/konopkov)! - The host dashboard lists its agents in Connect's row shape and state language instead of a card grid. Its heading is "Agents on HOST". Each row shows the state (icon and word), the name, kind and work. An agent with a stable id gets an "Open on the hub" link to its terminal in the canonical hub's Connect. The decorative presence dot and the "N agents" chip are gone; the "Agents online" summary still counts the same list. Empty and failure states name their cause: "No agents running on HOST." and "Herdr isn't running on HOST: …. Start Herdr on HOST, then refresh."

### Patch Changes

- [#652](https://github.com/knpkv/npm/pull/652) [`2b79b24`](https://github.com/knpkv/npm/commit/2b79b241a95d5e6d54c1055e0b245bd24a490276) Thanks [@konopkov](https://github.com/konopkov)! - Connect's agents now speak the hub's state language. Each directory row shows the agent's state as an icon and word in its tone, the same label the hub's Agent activity uses, instead of a plain capitalised word. Only working agents spin, and only with motion allowed. `waiting` now counts under the Status filter's "Needs you" (renamed from "Attention") rather than "Ready", because it waits on a person. The work line no longer repeats the state ("Root agent, npm", not "Root agent, Working in npm"), since the label beside it says it. Unknown states keep their own word with a caution alert icon, so they never look idle. `@knpkv/herdr-connect/surface` exports `agentStatePresentation`, `AgentStateLabel`, `agentBuckets` and `agentBucketLabel`. herdr-approvals' Agent activity reads the same mapping, so its state words are now capitalised and blocked and errored agents show in critical tone.

- [#662](https://github.com/knpkv/npm/pull/662) [`991e71e`](https://github.com/knpkv/npm/commit/991e71e413973fb6083f8abf972fc0f66ac701bf) Thanks [@konopkov](https://github.com/konopkov)! - The host dashboard puts its "Needs attention" agenda above the agent rows, so whatever needs a decision comes before what is merely running.
- Updated dependencies [[`2b79b24`](https://github.com/knpkv/npm/commit/2b79b241a95d5e6d54c1055e0b245bd24a490276), [`504148b`](https://github.com/knpkv/npm/commit/504148b49fef69471bd3772c60d1629758ccf930), [`5199a49`](https://github.com/knpkv/npm/commit/5199a4959d643d029a9b7701bce94d904250abfd), [`8acdf0d`](https://github.com/knpkv/npm/commit/8acdf0dbd0800c27d5dd4d0130e035558f575975), [`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/herdr-connect@0.9.0
  - @knpkv/rly@0.16.0
  - @knpkv/herdr-work@0.9.3

## 0.13.0

### Minor Changes

- [#650](https://github.com/knpkv/npm/pull/650) [`87a811a`](https://github.com/knpkv/npm/commit/87a811a150578ac809316fe3bb0eb190a7f5e051) Thanks [@konopkov](https://github.com/konopkov)! - The hub no longer has a coordinator chat. The chat panel is gone from the Approvals dashboard and from below Connect's terminal, the page stops polling for chat, and the `GET`/`POST /v1/chat` routes are removed. The dashboard snapshot drops `chat` and `approvalApp.chatEnabled`, and `dashboardPolls` no longer reports `chat`. Notifications now show on the canonical hub whether or not chat history exists. A coordinator chat job queued before the upgrade still runs through Fleet's `runCoordinatorChat`. `@knpkv/herdr-coordinator`'s chat model and Fleet's chat operations are unchanged.

### Patch Changes

- [#638](https://github.com/knpkv/npm/pull/638) [`51db213`](https://github.com/knpkv/npm/commit/51db213028b228bfff75f0dbcfd5e9add0fffc9b) Thanks [@konopkov](https://github.com/konopkov)! - The hub preloads Geist Mono as well as Geist. Ids and kickers are set in mono, and loading that face late re-wrapped a line in the Approvals detail at 390, shifting the page.

- [#644](https://github.com/knpkv/npm/pull/644) [`9a0dbd7`](https://github.com/knpkv/npm/commit/9a0dbd7d08661cbcdeaef12be2dbe6c99d08c226) Thanks [@konopkov](https://github.com/konopkov)! - The hub takes the fonts it preloads from rly's list of web font faces instead of naming the files itself, so a face rly adds is preloaded too.
- Updated dependencies [[`132d46b`](https://github.com/knpkv/npm/commit/132d46bc0ed8a881737a0ead6db9b32cbbac4889), [`5594373`](https://github.com/knpkv/npm/commit/5594373fe3479fa7cbae68608f8b7b84606407e6), [`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/herdr-connect@0.8.0
  - @knpkv/rly@0.15.0
  - @knpkv/herdr-work@0.9.2

## 0.12.0

### Minor Changes

- [#604](https://github.com/knpkv/npm/pull/604) [`0cb230c`](https://github.com/knpkv/npm/commit/0cb230c3a5ad2bde144f5cc5008dc7f0b5cdda8e) Thanks [@konopkov](https://github.com/konopkov)! - The fleet shell no longer acts on single bare keys. Tabs are `g` then `a` / `c` / `w` (Approvals, Connect, Work) within 1.5 seconds, agent search is Ctrl+K (Cmd+K), and `?` (or the masthead's "Keyboard shortcuts" button) lists every shortcut in a dialog; Alt combinations are left to the window manager. Typing in a field never triggers a sequence. The key rail above each tab is gone. The masthead reads on one line, says "3 hosts" rather than "3 configured hosts", and the Work tab keeps its page heading while its goals load or fail.

- [#621](https://github.com/knpkv/npm/pull/621) [`0b6ee77`](https://github.com/knpkv/npm/commit/0b6ee77ed2f18a4b4e055310e0e6f24194545961) Thanks [@konopkov](https://github.com/konopkov)! - A host's own dashboard page now hydrates cleanly. It was server-rendered as static markup, which merges adjacent text, and the browser then failed with React error [#418](https://github.com/knpkv/npm/issues/418) and re-rendered the page. It also stops polling `/v1/chat`, `/v1/push/config` and (when the fleet is cross-host) `/v1/work`, which that listener doesn't serve and which only answered 404. The dashboard snapshot's `approvalApp` gains `workEnabled`, set by the same rule the server uses to route `/v1/work`.

- [#620](https://github.com/knpkv/npm/pull/620) [`0c82504`](https://github.com/knpkv/npm/commit/0c825043b9911af87b99f3026c403280ea9e36c6) Thanks [@konopkov](https://github.com/konopkov)! - A failed hub refresh no longer replaces the whole app with "Host activity unavailable" and an error stack. The hub keeps showing the last update it had (the page's own snapshot if the very first refresh fails), with an inline "Couldn't refresh host activity. Showing the update from 09:41." notice and a Try again button. The cause goes to the log. `FleetShell` and `DashboardView` take an optional `notice` for page-level messages like this one, shown under the masthead in the page gutter.

### Patch Changes

- [#630](https://github.com/knpkv/npm/pull/630) [`3b3ae7d`](https://github.com/knpkv/npm/commit/3b3ae7d8c6f159e1e2d8ff79e5d3096fdefaefb1) Thanks [@konopkov](https://github.com/konopkov)! - Approvals: a request without an expiry says "No expiry" in its row and on its bar instead of leaving the clock's place empty; the "Waiting for you" count is the number listed, without an unexplained "+" (unchecked hosts and unloaded pages are said in words); and the machines panel is titled "Machines", lists this machine first without a loading spinner, and drops the "Fleet" eyebrow.

- [#626](https://github.com/knpkv/npm/pull/626) [`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d) Thanks [@konopkov](https://github.com/konopkov)! - An approval or other job write that finds the job store locked now answers 503 (`FleetStoreBusyError`, retryable) instead of 500. The approval proof survives, so retrying the same decision succeeds. Push-delivery and host-runner failures are still logged and skipped, now with a logging `Effect.catch` instead of a suppressed `Effect.ignore`.

- [#629](https://github.com/knpkv/npm/pull/629) [`74e28f3`](https://github.com/knpkv/npm/commit/74e28f3c6085b9c75bca7618ee65aedd3679c84f) Thanks [@konopkov](https://github.com/konopkov)! - Agent cards on the hub show each agent's state with its own icon instead of a spinner for everyone. A working agent's icon spins, and stays motionless when reduced motion is requested; idle, blocked and done agents have distinct still icons beside the state's word.

- [#618](https://github.com/knpkv/npm/pull/618) [`83ef4f7`](https://github.com/knpkv/npm/commit/83ef4f7c37fa14d4c43bc34288d57ceb9a5c2294) Thanks [@konopkov](https://github.com/konopkov)! - The hub writes its lines as phrases instead of joining facts with middots: "Showing 24 of 30 matching, 30 jobs in all", "Load earlier (6 remaining)", "claude, arch" for an agent, "knpkv/npm#433: existing owner" for a Work job, and "Host activity on SER8" as the page title. The keyboard hint reads "In the list, J and K move, Enter opens details and Esc clears the search", and J/K never act while a field inside the list has focus or a modifier is held. At phone width the activity filters wrap instead of scrolling sideways, so the last one ("Agent") no longer sits past the screen edge. The middot ast-grep rule now covers herdr-approvals.

- [#623](https://github.com/knpkv/npm/pull/623) [`c47e854`](https://github.com/knpkv/npm/commit/c47e8544c762aeb58a28811106e3acf768af12b1) Thanks [@konopkov](https://github.com/konopkov)! - The hub no longer jumps while its first content loads. Connect's agent directory and the Work board each hold a screen of space until their first content arrives, through a failed first request and its retry, so the coordinator chat (Connect) and the agents and history panels (Work) stay out of view instead of being pushed down when the list or board arrives. CLS on a cold load was 0.60 (Connect, 768) and 0.48 (Work, 1440).

- [#624](https://github.com/knpkv/npm/pull/624) [`321dd50`](https://github.com/knpkv/npm/commit/321dd50955037fa17c5da7c7be96a9b5d43efb31) Thanks [@konopkov](https://github.com/konopkov)! - The hub's agent lines and activity rows wrap instead of cutting text off. At phone width an agent's name and work no longer shrink to a few characters next to its state (the state drops under them instead), and activity titles and descriptions show in full at 768 and below. At 320 the Activity history search field stays inside its card, and the filter chips keep their inline padding. Below 24rem an activity row's time sits above its title, so titles no longer break mid-word, and the search placeholder fits.

- [#593](https://github.com/knpkv/npm/pull/593) [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597) Thanks [@konopkov](https://github.com/konopkov)! - Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap wherever glyphs are placed at subpixels (desktop Chrome on Linux as measured, and the usual macOS and Windows defaults); a Linux desktop set to full hinting can still move text slightly. Reading measures and title widths are set in `em` (at the weight each is drawn in) rather than `ch`, whose size follows the font's "0" and changed by 16% on the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.

- [#633](https://github.com/knpkv/npm/pull/633) [`1ba73ff`](https://github.com/knpkv/npm/commit/1ba73ff7cd71d9683175a1ef9df24f325988e04f) Thanks [@konopkov](https://github.com/konopkov)! - The hub's activity filter chips get their inline padding back (they referenced a spacing token rly doesn't define), and keyboard key caps name their bottom edge colour explicitly instead of through an undefined token, with no visual change.
- Updated dependencies [[`addf81d`](https://github.com/knpkv/npm/commit/addf81ddd5956692b571b5ecfc8ec2f3b3413aa2), [`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d), [`c47e854`](https://github.com/knpkv/npm/commit/c47e8544c762aeb58a28811106e3acf768af12b1), [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/herdr-coordinator@0.3.7
  - @knpkv/herdr-fleet@0.8.0
  - @knpkv/herdr-connect@0.7.4
  - @knpkv/rly@0.14.0
  - @knpkv/herdr-work@0.9.1

## 0.11.1

### Patch Changes

- Updated dependencies [[`16244c5`](https://github.com/knpkv/npm/commit/16244c58b41cd8dcee799fd8e8e058598df3fb90), [`0d6cc4d`](https://github.com/knpkv/npm/commit/0d6cc4df23eca64c5d29725bf50899776cc52435), [`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/herdr-connect@0.7.3
  - @knpkv/herdr-work@0.9.0
  - @knpkv/rly@0.13.0
  - @knpkv/herdr-coordinator@0.3.6

## 0.11.0

### Minor Changes

- [#602](https://github.com/knpkv/npm/pull/602) [`58aca11`](https://github.com/knpkv/npm/commit/58aca112c21203ee8955b130d5d891dabe2976a2) Thanks [@konopkov](https://github.com/konopkov)! - The Work tab decides a goal's approval request in place: its bar approves or rejects through the same call as the Approvals tab, shows the decision waiting for the hub, and says how the hub answered (taken, refused, or not yet known). Its clock reads hub time, like the Approvals countdown, and both tabs use the same clock words. An answer belongs to the request it decided, so a new request on the same job starts with a ready bar.

### Patch Changes

- Updated dependencies [[`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26), [`bfba87c`](https://github.com/knpkv/npm/commit/bfba87c566ca21d267c0626da60b431757dc5e32)]:
  - @knpkv/herdr-fleet@0.7.0
  - @knpkv/herdr-work@0.8.1
  - @knpkv/herdr-connect@0.7.2
  - @knpkv/herdr-coordinator@0.3.5

## 0.10.0

### Minor Changes

- [#512](https://github.com/knpkv/npm/pull/512) [`f3e0012`](https://github.com/knpkv/npm/commit/f3e0012b6106b3d142b8469f327f366b9aa2ba1f) Thanks [@konopkov](https://github.com/konopkov)! - The Approvals tab is a countdown:

  - It leads with the request that expires first ("4m 12s until Apply Nix configuration expires").
  - Every pending request, from this host and others, is listed soonest first, with its time left.
  - One decision bar sits on the selected request and names what it decides.

  Decisions show the hub's answer, including a refusal, never an assumed success. A request becomes expired only when the hub says so; at zero its clock reads "expiring". Screen readers hear a request once as it enters its last minute and when it expires, not every tick. Keyboard shortcuts follow the same rules as the buttons, so a request decided on another host, or one already being sent, can't be decided by keyboard either.

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.
- Updated dependencies [[`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa), [`1ef72d9`](https://github.com/knpkv/npm/commit/1ef72d9317a37e8f28563cae113e9908d8242c3a), [`f8e842e`](https://github.com/knpkv/npm/commit/f8e842e901986b50edf55f98fa3591b742a7904e), [`30849c5`](https://github.com/knpkv/npm/commit/30849c598fdf6776a3a4a2c4061d276e843eaa8e)]:
  - @knpkv/herdr-connect@0.7.1
  - @knpkv/rly@0.12.1
  - @knpkv/herdr-work@0.8.0
  - @knpkv/herdr-coordinator@0.3.4

## 0.9.0

### Minor Changes

- [#548](https://github.com/knpkv/npm/pull/548) [`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1) Thanks [@konopkov](https://github.com/konopkov)! - Connect knows where a terminal is really scrolled to. The hub reads herdr's scroll position for the open pane (at most twice a second per session and ten times a second across the host) and sends it to the browser, so a pane someone left scrolled back opens with "Older output, N lines back", and Latest returns in exactly that many lines, one command per frame, until a fresh reading says the pane is at the bottom. Readings are taken only while no scroll is in flight and carry the number of scrolls they cover, so the browser uses only those that already include every scroll it sent. Hosts send it only to clients that ask for it, so hubs and hosts can be upgraded in any order. When the position can't be read it is shown as unknown, never as the bottom, and Connect falls back to its previous behaviour.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
- Updated dependencies [[`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1), [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c), [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/herdr-connect@0.7.0
  - @knpkv/herdr-work@0.7.2
  - @knpkv/rly@0.12.0

## 0.8.0

### Minor Changes

- [#572](https://github.com/knpkv/npm/pull/572) [`74429d4`](https://github.com/knpkv/npm/commit/74429d4719b471ab7aaae230ad594f6c5e1755fb) Thanks [@konopkov](https://github.com/konopkov)! - The hostd composer receives `startedWorker(jobId)`, the worker Fleet's job record says that job started, or null when the job is unknown or started none. A background writer that acts on an agent can check its identity against this record instead of pane metadata, which any local agent can write. A job store that can't be read, or a composition without one, fails with `FleetStoreError`, never null.

### Patch Changes

- [#559](https://github.com/knpkv/npm/pull/559) [`8171e47`](https://github.com/knpkv/npm/commit/8171e47d54136a7f1b48572e3fc5c5a184bc7250) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl submit HOST work.* <json>` says what is wrong with the payload, in one line: each failing field and what it expected, for example `work.abandon payload: goalId: Missing key; reason: Expected string`. The payload's `kind` may be left out; it is the command's own. Before, any problem printed only "work.abandon payload is invalid".

- [#557](https://github.com/knpkv/npm/pull/557) [`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb) Thanks [@konopkov](https://github.com/konopkov)! - The coordinator chat no longer shows a hard-coded host name or a "Persistent" chip; turns read "You asked" or "You asked for work" with their state as a word, and the scrolling history is a named log a keyboard can reach. The notifications panel explains a blocked or unsupported browser instead of offering an Enable button that cannot work, names the cause when checking fails, and keeps its setup help inside the panel.
- Updated dependencies [[`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb), [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/herdr-connect@0.6.0
  - @knpkv/rly@0.11.0
  - @knpkv/herdr-work@0.7.1

## 0.7.0

### Minor Changes

- [#544](https://github.com/knpkv/npm/pull/544) [`6971fa1`](https://github.com/knpkv/npm/commit/6971fa10f21e1ec2739d2f9b83ecb63b8de74b47) Thanks [@konopkov](https://github.com/konopkov)! - The default operations now run `nix.apply` as the apply command followed by the ref and then the Fleet job id, so the apply command can record that job's own outcome. A host that restarts mid-apply can then settle the job from that record. An apply command that takes only the ref must ignore the second argument.

### Patch Changes

- [#529](https://github.com/knpkv/npm/pull/529) [`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl --help`, `fleetctl help` and `fleetctl work --help` now print plain usage and exit 0, even on a machine without a fleet configuration. A mistake now gets one line naming its cause, and a non-zero exit. That covers an unknown command, missing arguments, an unknown host (the line lists the known hosts) and an unknown job kind (it lists the kinds). Usage mistakes print the usage that applies after that line, with no `FleetValidationError:` prefix. A missing configuration file is reported as `no fleet configuration at PATH; create it, or set FLEET_CONFIG_PATH to an existing file` instead of a platform error.
- Updated dependencies [[`d183858`](https://github.com/knpkv/npm/commit/d1838583e51cd683e167d6cb735ebbfe552bdb7f), [`21ab62a`](https://github.com/knpkv/npm/commit/21ab62a25400f61f27a5230553e4d4780034b899), [`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8), [`d266e4c`](https://github.com/knpkv/npm/commit/d266e4cccb601e0d8006ce50e48743b8f347f21e), [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/herdr-connect@0.5.0
  - @knpkv/herdr-fleet@0.6.1
  - @knpkv/herdr-work@0.7.0
  - @knpkv/rly@0.10.0
  - @knpkv/herdr-coordinator@0.3.3

## 0.6.0

### Minor Changes

- [#517](https://github.com/knpkv/npm/pull/517) [`a2d8fb6`](https://github.com/knpkv/npm/commit/a2d8fb6bbd629c6cef3238150c47f42d0835e29b) Thanks [@konopkov](https://github.com/konopkov)! - Hostd composers receive `hasOutstandingWorkJob`: whether any Work job in hostd's job store is still to run (pending approval, queued or running), so a background Work writer can defer its writes and keep pending approvals valid. `makeHostdOperations` takes the job store as an optional third argument, and `makeHostdProgram` now opens the job store before composing operations.

- [#523](https://github.com/knpkv/npm/pull/523) [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f) Thanks [@konopkov](https://github.com/konopkov)! - New approval-bound `work.abandon` job, which moves one Work goal to `abandoned`. The payload names the goal, its exact owner, a reason and the goal's expected head. The job hash covers every field, and the job always needs approval. `WorkService.abandon` clears the blocker and records a status activity naming the approved job. It refuses a goal with an active lane (`WorkGoalLaneActiveError`, naming the lane), a goal that has already finished (`WorkGoalTerminalError`), a stale head and a different owner. An exact replay returns the stored result. `runWorkAbandon` executes the job only with a persisted approval. The hub shows its fields, history and dashboard label, and `fleetctl submit HOST work.abandon PAYLOAD_JSON` submits it.

### Patch Changes

- Updated dependencies [[`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9), [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f), [`18d5c8b`](https://github.com/knpkv/npm/commit/18d5c8b1bead309094021b0b54fb9d49b83fc50a), [`c037ee6`](https://github.com/knpkv/npm/commit/c037ee6bffca3178d82c5d29a3f203de26db146e), [`b0b385c`](https://github.com/knpkv/npm/commit/b0b385cbfa570e19dd4fa81cd553d3aaf957361f), [`8d051cb`](https://github.com/knpkv/npm/commit/8d051cb05a9b22d59d348346e1f45897fec187b3), [`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9), [`aac9574`](https://github.com/knpkv/npm/commit/aac9574b6614cdf1f2be74d641c9a191b7e8c903)]:
  - @knpkv/herdr-connect@0.4.5
  - @knpkv/rly@0.9.0
  - @knpkv/herdr-fleet@0.6.0
  - @knpkv/herdr-work@0.6.0
  - @knpkv/herdr-coordinator@0.3.2

## 0.5.4

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d), [`8363bd4`](https://github.com/knpkv/npm/commit/8363bd4dd5fc6df3b15ae70132c080bd52d19a0f)]:
  - @knpkv/rly@0.8.0
  - @knpkv/herdr-work@0.5.3
  - @knpkv/herdr-connect@0.4.4

## 0.5.3

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0
  - @knpkv/herdr-connect@0.4.3
  - @knpkv/herdr-work@0.5.2

## 0.5.2

### Patch Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/bounded-io@0.2.0
  - @knpkv/herdr-connect@0.4.2
  - @knpkv/herdr-fleet@0.5.1
  - @knpkv/herdr-tailscale@0.3.1

## 0.5.1

### Patch Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
- Updated dependencies [[`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e)]:
  - @knpkv/herdr-fleet@0.5.0
  - @knpkv/herdr-work@0.5.1
  - @knpkv/herdr-connect@0.4.1
  - @knpkv/herdr-coordinator@0.3.1

## 0.5.0

### Minor Changes

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#446](https://github.com/knpkv/npm/pull/446) [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e) Thanks [@konopkov](https://github.com/konopkov)! - Recover an existing unlinked canonical Work goal through a read-only recovery context and preflight, then an approved, history-guarded recovery that links it to an exact worker without rewriting its original checkpoint. Accept the exact legacy worktree repository representation, add prospective PR admission preflight, and expose the recovery and admission routes through fleetctl and the approvals HTTP API. Add typed work.admit, work.recover and work.reconcile Fleet operations, which a host accepts at submission only when its composed Work adapter declares them in `HostOperations.workJobKinds`, and bot-review and formal-review evidence in pull-request evidence.

- [#406](https://github.com/knpkv/npm/pull/406) [`7602437`](https://github.com/knpkv/npm/commit/760243717e7d09adb74816d521a85b89c08a5dc5) Thanks [@konopkov](https://github.com/konopkov)! - Show a redacted, expandable approval request in pending and decision history views.

- [#419](https://github.com/knpkv/npm/pull/419) [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949) Thanks [@konopkov](https://github.com/konopkov)! - Expose a scoped hostd operations composer for durable coordinator injection, including crash-safe receipt recovery, bounded terminal summaries, and accepted job identity.

- [#424](https://github.com/knpkv/npm/pull/424) [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet tabs in one compact iPhone row, preserve terminal pointer access, and distinguish Work loading and failure states.

- [#451](https://github.com/knpkv/npm/pull/451) [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65) Thanks [@konopkov](https://github.com/konopkov)! - Queue `nix.*` and `agent.*` jobs submitted through the verified local hostd listener without approval; Work authority jobs and remote submissions still require approval.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

- [#447](https://github.com/knpkv/npm/pull/447) [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069) Thanks [@konopkov](https://github.com/konopkov)! - Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The request names the agent outcome explicitly: `set` moves the goal's agent target and rebinds a bound lane to the new worker, `clear` removes the target, and `keep` is accepted only when the goal has none. `set` is refused, with nothing written, when the agent is already the current target of another goal or the authoritative binding of another goal's lane. A shipped lane keeps its previous owner, and admission preflight treats each lane's latest binding as its authority, so a rebound lane still reads as existing for its new worker. The new checkpoint records who approved it, the activity summary is bounded before approval, and replaying the same approval job is idempotent. Approvals render every hash-bound field of the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host that declares `work.reassign` in `HostOperations.workJobKinds`. A host without that adapter refuses the job at submission. `canonicalJobPayload` exports the exact text bound into a job's approval hash. Every Work approval request now displays each of its hash-bound fields, including worker names and admission worker lineage.

  Follow-up, not covered here: lane claims and checkpoint appends can still change an owner without an approved reassignment.

### Patch Changes

- [#421](https://github.com/knpkv/npm/pull/421) [`ffeaaf2`](https://github.com/knpkv/npm/commit/ffeaaf23ed4e7bb31d4ac0805b394173d67284c1) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet application tabs clickable while an embedded Connect terminal is active and focused.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.
- Updated dependencies [[`c2da700`](https://github.com/knpkv/npm/commit/c2da70083bc4f8e82f9c6bd3dc2541e131585a5c), [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`17df0ad`](https://github.com/knpkv/npm/commit/17df0ad67dcf339d0d9541656be1ce236c3e34a2), [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277), [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`2f51fbb`](https://github.com/knpkv/npm/commit/2f51fbb893a6440ecd5cabf6b73bb52131395bc3), [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`de01905`](https://github.com/knpkv/npm/commit/de0190543c6b030f8616f68d78192cb65cc98899), [`a7db83b`](https://github.com/knpkv/npm/commit/a7db83b401fbe08a6a05d2500ec020cd6d03c8e6), [`2cb8964`](https://github.com/knpkv/npm/commit/2cb8964f9427e938c9aa75a3d401908884482d38), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59), [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401), [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069)]:
  - @knpkv/herdr-work@0.5.0
  - @knpkv/rly@0.6.0
  - @knpkv/herdr-connect@0.4.0
  - @knpkv/herdr-coordinator@0.3.0
  - @knpkv/herdr-fleet@0.4.0
  - @knpkv/herdr-tailscale@0.3.0

## 0.4.0

### Minor Changes

- [#404](https://github.com/knpkv/npm/pull/404) [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2) Thanks [@konopkov](https://github.com/konopkov)! - Add an opt-in read-only LAN Work listener with five-minute browser pairing.

- [#401](https://github.com/knpkv/npm/pull/401) [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364) Thanks [@konopkov](https://github.com/konopkov)! - Add a typed LAN Work listener for non-browser clients and route local Work commands through its fixed checkpoint and snapshot endpoints. This typed listener does not provide browser pairing: it intentionally serves only its typed JSON routes, with no same-origin page or cross-origin browser grant.

- [#407](https://github.com/knpkv/npm/pull/407) [`cf83d20`](https://github.com/knpkv/npm/commit/cf83d20883d8eca0bc1fcddeb0632a94c947a238) Thanks [@konopkov](https://github.com/konopkov)! - Harden the typed Work record and snapshot bridge with structural replay idempotency and fail-closed response decoding.

### Patch Changes

- Updated dependencies [[`1800d52`](https://github.com/knpkv/npm/commit/1800d528024607ef63dbfd0cd8a92a8b8622f783), [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2), [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364), [`cf83d20`](https://github.com/knpkv/npm/commit/cf83d20883d8eca0bc1fcddeb0632a94c947a238)]:
  - @knpkv/herdr-work@0.4.0
  - @knpkv/herdr-fleet@0.3.0
  - @knpkv/rly@0.5.1
  - @knpkv/herdr-connect@0.3.1
  - @knpkv/herdr-coordinator@0.2.1

## 0.3.0

### Minor Changes

- [#398](https://github.com/knpkv/npm/pull/398) [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5) Thanks [@konopkov](https://github.com/konopkov)! - Add stable form identities for the Work activity search and Connect terminal inputs.

- [#392](https://github.com/knpkv/npm/pull/392) [`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7) Thanks [@konopkov](https://github.com/konopkov)! - Bind persisted Work approval targets to the configured approval page origin before recording them.

### Patch Changes

- Updated dependencies [[`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5)]:
  - @knpkv/herdr-work@0.3.0
  - @knpkv/herdr-connect@0.3.0
  - @knpkv/rly@0.5.0

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.

- [#388](https://github.com/knpkv/npm/pull/388) [`182cdbc`](https://github.com/knpkv/npm/commit/182cdbcaa20824c95763b9ddc0695f1ec6ae5ace) Thanks [@konopkov](https://github.com/konopkov)! - Make Work checkpoint recording loopback-only, idempotent for exact replays, and available through `fleetctl work snapshot`.

### Patch Changes

- [#389](https://github.com/knpkv/npm/pull/389) [`618325b`](https://github.com/knpkv/npm/commit/618325b3f61d48ffaa7efef223e987e45493b6f4) Thanks [@konopkov](https://github.com/konopkov)! - Ignore recognized Herdr launch-pending inventory entries while keeping unknown malformed entries strict.
- Updated dependencies [[`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0), [`3d72330`](https://github.com/knpkv/npm/commit/3d72330d69ce0309436c470d8ba4557c7bfa6edf), [`182cdbc`](https://github.com/knpkv/npm/commit/182cdbcaa20824c95763b9ddc0695f1ec6ae5ace), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2)]:
  - @knpkv/herdr-connect@0.2.0
  - @knpkv/herdr-coordinator@0.2.0
  - @knpkv/herdr-fleet@0.2.0
  - @knpkv/herdr-tailscale@0.2.0
  - @knpkv/herdr-work@0.2.0
  - @knpkv/rly@0.4.1
