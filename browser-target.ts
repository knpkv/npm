/**
 * The browsers every knpkv browser build supports, in esbuild's target format. Vite (`build.target`, which
 * Lightning CSS also reads through `build.cssTarget`) and the esbuild asset scripts all take it, so the JS
 * and CSS they emit assume exactly these engines.
 *
 * The floor comes from CSS the apps write unconditionally: `light-dark()` needs Chrome 123, Edge 123,
 * Firefox 120 and Safari 17.5, and `safe` alignment (`align-items: safe center`) needs Safari 17.6. Vite 8's
 * default (`baseline-widely-available`: Chrome 111, Safari 16.4) is below that, so a build would lower or
 * rewrite those features for browsers the apps do not support. Raise this when the CSS needs more; never
 * set a build's target anywhere else (`scripts/check-browser-target.mjs` enforces that).
 */
export const BROWSER_TARGET = ["chrome123", "edge123", "firefox120", "safari17.6"]
