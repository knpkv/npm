# @knpkv/browser-pairing

## 0.7.0

### Minor Changes

- [#843](https://github.com/knpkv/npm/pull/843) [`929ef05`](https://github.com/knpkv/npm/commit/929ef055945cffcdb9d78fc2708ee1871c1126e3) Thanks [@konopkov](https://github.com/konopkov)! - Add `readOrigin` to `makeWebControl` for read-only projection of a canonical HTTP loopback
  origin from the owner-private control file. Reuse private-path checks without decoding
  the bearer token, requesting login or changing files. Unsafe or missing registrations
  fail as `WebNotRunning` without retaining private causes.

## 0.6.0

### Minor Changes

- [#841](https://github.com/knpkv/npm/pull/841) [`d9b889e`](https://github.com/knpkv/npm/commit/d9b889e13690c701f94448d831efbc0ae875624f) Thanks [@konopkov](https://github.com/konopkov)! - Share the owner-only web control file and bearer login route through the browser-pairing control export. Keep existing sign-in commands and product messages.

  The week-view control file moves to `~/.jcf/web/control.json` in its own private leaf directory, so existing configuration directories keep their permissions. Legacy control files stay untouched and are no longer read.

  The week view now rejects linked or permissive control paths and malformed or foreign bootstrap URLs, matching the stricter shared checks.

  Breaking for direct importers: the inferred service requirements and error types of `jira-clockify`'s `WebControl.writeControlFile` / `removeControlFile` and `jcf-web`'s `makeCommand` change, and `jcf-web` no longer exports `loginControlRouter` (use the one from `@knpkv/browser-pairing/control`).

## 0.5.1

### Patch Changes

- [#819](https://github.com/knpkv/npm/pull/819) [`2dc1b33`](https://github.com/knpkv/npm/commit/2dc1b33cf3c27ee2cc61e5476a6665e574a46792) Thanks [@konopkov](https://github.com/konopkov)! - The shared browser opener runs in the caller's process group, so the browser it starts is no longer killed when the opener exits.

## 0.5.0

### Minor Changes

- [#801](https://github.com/knpkv/npm/pull/801) [`5373375`](https://github.com/knpkv/npm/commit/53733753079c8b439f1574ceb23cafc9718aba57) Thanks [@konopkov](https://github.com/konopkov)! - Add shared browser-launch policy, an injectable opener, and scoped open-or-serve orchestration. Reuse the shared opener for the web command without exposing sign-in URLs in launch warnings.

## 0.4.1

### Patch Changes

- [`4ebe301`](https://github.com/knpkv/npm/commit/4ebe30154220bff53ec507a0d70c5f8f4a543c5a) Thanks [@konopkov](https://github.com/konopkov)! - Docs and comments state each rule and its reason directly instead of pointing at internal decision records.

## 0.4.0

### Minor Changes

- [#493](https://github.com/knpkv/npm/pull/493) [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/browser-pairing/owner-session` adds `serveWithBootstrapUrl(server, onReady)`. It runs a server layer, waits until it is listening, hands its bootstrap URL to `onReady`, and keeps serving. A launch that fails before it is listening fails without announcing a URL, and a failing `onReady` stops the server. `agent-usage serve`, `jcf-web` and `codecommit-web` now start their servers through it instead of three copies of that code. `@knpkv/codecommit-web` also exports `serveCodeCommit(options)` (`hostname`, `port`, `onReady`), the start sequence its own entry uses.

## 0.3.0

### Minor Changes

- [#466](https://github.com/knpkv/npm/pull/466) [`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/browser-pairing/owner-session`: the shared Owner Session for single-operator loopback web apps — session, CSRF and one-time bootstrap credentials, request authorization by cookie, Origin, Fetch Metadata and CSRF token (or read-only), loopback origin helpers, and the `POST /auth/bootstrap` route.

## 0.2.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#408](https://github.com/knpkv/npm/pull/408) [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e) Thanks [@konopkov](https://github.com/konopkov)! - Share typed, redacted browser-pairing credentials and transport primitives between Control Center and CodeCommit.
