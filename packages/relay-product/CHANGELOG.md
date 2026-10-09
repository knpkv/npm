# @knpkv/relay-product

## 0.4.0

### Minor Changes

- [#715](https://github.com/knpkv/npm/pull/715) [`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4) Thanks [@konopkov](https://github.com/konopkov)! - Relay's mark shows when Relay is working in the products. relay-product marks the launcher, panel and dock as working while a continuation sent from Relay waits on its answer, or while the product reports its own run through the registration's new `working` field; codecommit-web reports a running PR review. RelayMark's entrance now moves each stroke instead of the whole svg, and a mark that opens already working starts its loop as the entrance ends.

### Patch Changes

- Updated dependencies [[`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4), [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84), [`eb2ddfd`](https://github.com/knpkv/npm/commit/eb2ddfd124b3e8805d886fa26c178aa59231f1b4)]:
  - @knpkv/rly@0.18.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f), [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96), [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10), [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f), [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44)]:
  - @knpkv/rly@0.17.0

## 0.3.0

### Minor Changes

- [#661](https://github.com/knpkv/npm/pull/661) [`26d9de9`](https://github.com/knpkv/npm/commit/26d9de9c64b78da62ab462856cbd09e9137eb40f) Thanks [@konopkov](https://github.com/konopkov)! - A ready pull-request registration may name what the next message is about (`about: { id, label, onClear }`, a finding say); `RelayProductPanel` shows it as a removable reference on the composer, says when it changes under a kept draft, and clearing it sends to the whole pull request. `useRelayProductOpen().openFrom(control)` opens Relay from a page control and returns focus there on close.

- [#663](https://github.com/knpkv/npm/pull/663) [`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6) Thanks [@konopkov](https://github.com/konopkov)! - `RelayProductLauncher` takes a `scope` and names what it is about in its accessible description (the registered pull request first), keeping its visible label. A host may offer another conversation (`alternate: { label, onOpen }`), shown before the pull-request locator when none is registered and after it while finding another; Relay closes before leaving for it. A ready registration may carry a `notice` the panel shows above its composer.

- [#659](https://github.com/knpkv/npm/pull/659) [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327) Thanks [@konopkov](https://github.com/konopkov)! - Add `RelayProductLauncher` and `RelayProductPanel`, the product chrome rebuilt on rly's Relay components: a header launcher, the panel with its transcript and composer (drafts keyed by the complete thread identity), one Run with preset where profile and model are coupled, a locator that names the pull-request-only scope, and one keyboard summon per provider, and a pin each host declares per layout. `RelayProductDock` stays exported until hosts migrate.

### Patch Changes

- Updated dependencies [[`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/rly@0.16.0

## 0.2.9

### Patch Changes

- Updated dependencies [[`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/rly@0.15.0

## 0.2.8

### Patch Changes

- [#635](https://github.com/knpkv/npm/pull/635) [`4ff1f03`](https://github.com/knpkv/npm/commit/4ff1f0386648e41cfee2d0198c7c30c312c60539) Thanks [@konopkov](https://github.com/konopkov)! - The read permission bar docks to the bottom edge instead of entering the page above it, so a prompt that arrives after the page has painted no longer pushes everything down (the Settings layout shift on a first run). The page keeps the bar's height free at its end. While the identity read waits for that permission, Settings → Accounts says "Waiting for read permission" instead of a sign-in state.

  The Relay chip sits above the docked bar instead of covering its answers: `@knpkv/relay-product`'s dock adds the host's `--app-bottom-inset` to its bottom offset. The bar's sentence is shorter, and Accounts says "Waiting for read permission" whenever any read waits.

- Updated dependencies [[`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/rly@0.14.0

## 0.2.7

### Patch Changes

- Updated dependencies [[`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/rly@0.13.0

## 0.2.6

### Patch Changes

- Updated dependencies [[`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/rly@0.12.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/rly@0.11.0

## 0.2.4

### Patch Changes

- Updated dependencies [[`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/rly@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [[`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf)]:
  - @knpkv/rly@0.9.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d)]:
  - @knpkv/rly@0.8.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0

## 0.2.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

### Patch Changes

- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/rly@0.6.0

## 0.1.0

### Minor Changes

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Add one shared, collapsed Relay dock with durable pull-request threads, visible
  model and profile selection, and host-to-pull-request continuation.

### Patch Changes

- Updated dependencies [[`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/rly@0.5.0
