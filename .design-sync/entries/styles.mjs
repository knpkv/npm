// Pulls rly's shipped stylesheet into the design-sync bundle. dist/styles.css is only an
// @import list, so esbuild resolves the whole closure (fonts, tokens, base, components) here.
import "../../packages/rly/dist/styles.css"
