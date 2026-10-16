# @knpkv/alchemy-console

## 0.5.2

### Patch Changes

- [#958](https://github.com/knpkv/npm/pull/958) [`fb09f42`](https://github.com/knpkv/npm/commit/fb09f424ddd8b8b7b65fc71d6361dd7e2caca418) Thanks [@konopkov](https://github.com/konopkov)! - Pin `@effect/platform-node-shared` to the same release as `effect`. `@effect/platform-node` declares it with a caret range, so a fresh install picked up a newer release that imports `Path.make`, which `effect` 4.0.0 lacks. The CLI then failed at startup with npm or pnpm.

## 0.5.1

### Patch Changes

- [#911](https://github.com/knpkv/npm/pull/911) [`851a243`](https://github.com/knpkv/npm/commit/851a24361f1c2eb72129f679ccf57b46ebc9306e) Thanks [@konopkov](https://github.com/konopkov)! - Order CI plan reruns by attempt start time, classify inaccessible fixed CI endpoints as access refusals, and document canonical receipt identity boundaries.

## 0.5.0

### Minor Changes

- [#909](https://github.com/knpkv/npm/pull/909) [`fd92fa2`](https://github.com/knpkv/npm/commit/fd92fa2857c7418abc0152d93b5ca0aa6da553b2) Thanks [@konopkov](https://github.com/konopkov)! - Add a read-only Plan tab for verified CI publications, with authenticated bounded artifact reading and explicit stale, unavailable and access states. The console never executes stack code or displays property values.

## 0.4.2

### Patch Changes

- Updated dependencies [[`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9)]:
  - @knpkv/rly@0.23.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`5db8146`](https://github.com/knpkv/npm/commit/5db8146fa812d17d2c2c630cde641be5d654bdac)]:
  - @knpkv/browser-pairing@0.8.0

## 0.4.0

### Minor Changes

- [#848](https://github.com/knpkv/npm/pull/848) [`b8dce18`](https://github.com/knpkv/npm/commit/b8dce18f90b48e04c563ef7c09b82c2a55b71b99) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated read-only stack and resource detail views, resource-own provider identity and console links, bounded dependencies, and hidden output-key discovery.

## 0.3.2

### Patch Changes

- Updated dependencies [[`929ef05`](https://github.com/knpkv/npm/commit/929ef055945cffcdb9d78fc2708ee1871c1126e3)]:
  - @knpkv/browser-pairing@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`d9b889e`](https://github.com/knpkv/npm/commit/d9b889e13690c701f94448d831efbc0ae875624f)]:
  - @knpkv/browser-pairing@0.6.0

## 0.3.0

### Minor Changes

- [#838](https://github.com/knpkv/npm/pull/838) [`686a11d`](https://github.com/knpkv/npm/commit/686a11d478903647941d4a791e70fe6222857003) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated stack discovery screens and reusable browser views, with explicit incomplete discovery and owner sign-in states.

## 0.2.1

### Patch Changes

- Updated dependencies [[`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127), [`2dc1b33`](https://github.com/knpkv/npm/commit/2dc1b33cf3c27ee2cc61e5476a6665e574a46792)]:
  - @knpkv/bounded-io@0.3.0
  - @knpkv/browser-pairing@0.5.1

## 0.2.0

### Minor Changes

- [#810](https://github.com/knpkv/npm/pull/810) [`d7adebe`](https://github.com/knpkv/npm/commit/d7adebecc37849465a7dddad0248ccb0f29e044c) Thanks [@konopkov](https://github.com/konopkov)! - Add the owner-authenticated stack API and local CLI with single-use browser login and read-only local/S3 discovery.

## 0.1.0

### Minor Changes

- [#777](https://github.com/knpkv/npm/pull/777) [`8d99926`](https://github.com/knpkv/npm/commit/8d99926441f1154fe0061843035290d712f63f22) Thanks [@konopkov](https://github.com/konopkov)! - Discover local SSO profiles and add a read-only S3 adapter with version-pinned state reads and redacted metadata.

- [#770](https://github.com/knpkv/npm/pull/770) [`8858563`](https://github.com/knpkv/npm/commit/88585630bb6d752f13a87eb07ff0d03f4bd159cc) Thanks [@konopkov](https://github.com/konopkov)! - Add read-only local Alchemy project discovery and metadata-only state readers.
