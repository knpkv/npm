---
"@knpkv/rly": minor
"@knpkv/agent-usage": patch
"@knpkv/codecommit-web": patch
"@knpkv/control-center": patch
"@knpkv/herdr-monitor": patch
"@knpkv/jcf-web": patch
"@knpkv/herdr-approvals": patch
"@knpkv/review": patch
---

Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.
