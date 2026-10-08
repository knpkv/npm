---
"@knpkv/agent-usage": patch
---

`@knpkv/agent-usage/limits` resolves from the built package. Its modules now live in `src/limits/`, so they build to `dist/limits/` instead of `dist/client/`, which the page build empties. The stylesheet moves to `src/limits/limits.css`; its `@knpkv/agent-usage/limits.css` path is unchanged.
