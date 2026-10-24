# @knpkv/alchemy-console

## 0.6.3

### Patch Changes

- Updated dependencies [[`7ecb2d6`](https://github.com/knpkv/npm/commit/7ecb2d6f3a19d582d286768973a57dbab5786738)]:
  - @knpkv/rly@0.25.0

## 0.6.2

### Patch Changes

- [#1041](https://github.com/knpkv/npm/pull/1041) [`6e6d029`](https://github.com/knpkv/npm/commit/6e6d029fd0979aca90815ab4a0a6d8bed5967887) Thanks [@konopkov](https://github.com/konopkov)! - READMEs open with "Run it on its own": the `npx` command, its port, and what it runs without. Packages with no executable say where they run instead. CodeCommit web no longer claims it needs Bun; only the terminal UI does.

## 0.6.1

### Patch Changes

- [#1037](https://github.com/knpkv/npm/pull/1037) [`c2fdb19`](https://github.com/knpkv/npm/commit/c2fdb1980aa21778918ef054cefbc1103c8fbcc0) Thanks [@konopkov](https://github.com/konopkov)! - `alchemy-console --help` describes the `login` and `serve` subcommands.

## 0.6.0

### Minor Changes

- [#1024](https://github.com/knpkv/npm/pull/1024) [`56c6996`](https://github.com/knpkv/npm/commit/56c6996b14b35f508ed83d2fd780d54f8dca1232) Thanks [@konopkov](https://github.com/konopkov)! - Local discovery no longer fails the whole walk on one bad entry. Symlinks that leave the search root are skipped (never followed), and dangling ones too, since they lead nowhere. Any other entry that can't be read is counted and skipped, so the projects that were found are still read. `discoverProjects` now returns `{ projects, unreadable }`. A walk that skipped unreadable entries reports one `local: skipped` discovery issue next to its stacks; only an unreadable root still fails.

  Such a partial walk is reported as a new `local: skipped` discovery issue (`DiscoveryIssue.reason` gains `"skipped"`), kept distinct from `local: io`, which now means the root or a project's state couldn't be read. S3 discovery reports at most one issue per profile and reason, so an expired profile with several buckets is one sign-in issue, not one per bucket.

- [#1015](https://github.com/knpkv/npm/pull/1015) [`382cdd3`](https://github.com/knpkv/npm/commit/382cdd3c116c1b9d956c1ea55e4956eb10345178) Thanks [@konopkov](https://github.com/konopkov)! - Add `./host` and `./host/server` exports so another server, such as a Relay Hub module, can serve the stacks read model. `./host` has the tagged result contracts (`StacksOverviewResult`, `StackDetailResult`, `StackPlanResult`, `StacksUnavailable`) and the `StackQuery` selector. `./host/server` has `stacksHostLayer`, the same discovery, SSO and plan reader the standalone console runs, `stacksHostOptions` for its paths, and `makeStacksHostReads`, which returns a failed discovery as a result rather than an error.

- [#1028](https://github.com/knpkv/npm/pull/1028) [`65ee3f4`](https://github.com/knpkv/npm/commit/65ee3f4f155d0516416482bd039bc30ffb124e48) Thanks [@konopkov](https://github.com/konopkov)! - Overview discovery stops the local project walk after 5 seconds or 50,000 directories and keeps the projects already found. The walk checks that clock before each directory entry, so one wide directory stops on the same budget. `discoverProjects` now returns `truncated` with those projects. A stopped walk reports one `local: truncated` issue and still reads the projects it found. A state file past its size limit stays `local: limit`. The walk and every AWS profile share one 20 second deadline. Profiles are read three at a time. A profile holds its slot for at most 8 seconds, and only while time remains in that deadline. A profile that has not finished is one `s3: provider` issue. Stacks from profiles that finished stay. Two profile names for the same account, role, start URL, session and region are read once. SSO resolution leaves the session token cache in use.

- [#1016](https://github.com/knpkv/npm/pull/1016) [`2ca72de`](https://github.com/knpkv/npm/commit/2ca72dec189c75ac63cb5f6f3d62540d92249ad2) Thanks [@konopkov](https://github.com/konopkov)! - Export the stack page's parts from `./views` so a host can compose its own page around them: `StackResourcesView` (the resource table), `StackOutputsView` (the outputs list) and `StackStateTree` (resources grouped by construct parent and type). `StackResourcesView` and `StackStateTree` take `resourceHref: null` to render resource names as plain text for a host with no resource page. `StackDetailView` renders the same parts as before.

  The empty-state creatures are now CSS backgrounds instead of `<img>` elements whose URL came from `import.meta.url`, so `./views` loads in bundles without `import.meta.url`. A consumer's CSS build must resolve the stylesheet's SVG `url()`s.

  The plan's source line no longer prints commit hashes: it reads "PR #n · published <time>", with the head and base commits in its tooltip.

  The plan digest moves into that tooltip too, and the stack page's counts and dates use commas instead of middots.

- [#1027](https://github.com/knpkv/npm/pull/1027) [`6140a40`](https://github.com/knpkv/npm/commit/6140a4020fa624365382fd8716592d33425c932d) Thanks [@konopkov](https://github.com/konopkov)! - Plan head, base and digest ids are copy buttons. The plan line and Stacks Activity show the words Head, Base and Digest. The short id is the button's name and the clipboard value, not the visible text.

### Patch Changes

- [#1021](https://github.com/knpkv/npm/pull/1021) [`e58ea2f`](https://github.com/knpkv/npm/commit/e58ea2f90e1b30580ab9eb201033ad21cfb09f11) Thanks [@konopkov](https://github.com/konopkov)! - Read Bun's text lockfile without `jsonc-parser`. Its CommonJS entry loads its parts through `require()` calls that a bundle can't resolve, so a Node bundle of `./host/server` failed at load with "Cannot find module './impl/format'". A small parser now accepts the same input (trailing commas and comments), and a test bundles `./host/server` for Node and loads it.

- [#1029](https://github.com/knpkv/npm/pull/1029) [`bf62e19`](https://github.com/knpkv/npm/commit/bf62e19a1db55acd14169dbd315e694cc9e15e8a) Thanks [@konopkov](https://github.com/konopkov)! - IconButton has an inline size: a 28px box, a 16px icon, and the shared 44px hit area. It stays 28px on a coarse pointer. CommitLabel and the plan id buttons use that size and no longer set their own box. A successful copy says Copied in a polite live region for about 2 seconds, and the button shows a check in the same box. The id stays out of that text.
- Updated dependencies [[`7015e2c`](https://github.com/knpkv/npm/commit/7015e2cd1315f80a6198e62c0344bb41cb3d68dd), [`bf62e19`](https://github.com/knpkv/npm/commit/bf62e19a1db55acd14169dbd315e694cc9e15e8a)]:
  - @knpkv/rly@0.24.0

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
