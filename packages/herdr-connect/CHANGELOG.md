# @knpkv/herdr-connect

## 0.4.0

### Minor Changes

- [#412](https://github.com/knpkv/npm/pull/412) [`17df0ad`](https://github.com/knpkv/npm/commit/17df0ad67dcf339d0d9541656be1ce236c3e34a2) Thanks [@konopkov](https://github.com/konopkov)! - Add an accessible terminal special-key rail with safe one-shot Ctrl and Alt controls.

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#423](https://github.com/knpkv/npm/pull/423) [`a7db83b`](https://github.com/knpkv/npm/commit/a7db83b401fbe08a6a05d2500ec020cd6d03c8e6) Thanks [@konopkov](https://github.com/konopkov)! - Keep embedded mobile terminals below Fleet navigation, restore focus safely when entering and leaving terminals, and expose every host and status filter on narrow screens.

### Patch Changes

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#427](https://github.com/knpkv/npm/pull/427) [`de01905`](https://github.com/knpkv/npm/commit/de0190543c6b030f8616f68d78192cb65cc98899) Thanks [@konopkov](https://github.com/konopkov)! - Lock document scrolling while an agent terminal is open and restore the prior page position and inline styles when it closes.
- Updated dependencies [[`c2da700`](https://github.com/knpkv/npm/commit/c2da70083bc4f8e82f9c6bd3dc2541e131585a5c), [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277), [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`2cb8964`](https://github.com/knpkv/npm/commit/2cb8964f9427e938c9aa75a3d401908884482d38), [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401)]:
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
