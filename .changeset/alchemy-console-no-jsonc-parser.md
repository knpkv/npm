---
"@knpkv/alchemy-console": patch
---

Read Bun's text lockfile without `jsonc-parser`. Its CommonJS entry loads its parts through `require()` calls that a bundle can't resolve, so a Node bundle of `./host/server` failed at load with "Cannot find module './impl/format'". A small parser now accepts the same input (trailing commas and comments), and a test bundles `./host/server` for Node and loads it.
