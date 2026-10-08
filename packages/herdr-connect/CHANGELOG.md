# @knpkv/herdr-connect

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
