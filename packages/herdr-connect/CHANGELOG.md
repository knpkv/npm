# @knpkv/herdr-connect

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
