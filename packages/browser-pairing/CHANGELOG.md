# @knpkv/browser-pairing

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
