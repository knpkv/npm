/**
 * Compatibility boundary for legacy synchronous OAuth helpers.
 *
 * New Effect workflows must obtain time from `Clock.currentTimeMillis` and call
 * the corresponding `*At` helper. This host-clock read remains only so the
 * existing synchronous public API does not change without a major release.
 *
 * @internal
 */
export const unsafeCurrentTimeMillis = (): number => Date.now()
