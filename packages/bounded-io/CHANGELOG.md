# @knpkv/bounded-io

## 0.3.0

### Minor Changes

- [#822](https://github.com/knpkv/npm/pull/822) [`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127) Thanks [@konopkov](https://github.com/konopkov)! - Add `collectTail` and `collectTailText`: read a stream to its end and keep only its last `limit` bytes, reporting how many were dropped. The text form starts on a character boundary.

## 0.2.0

### Minor Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
