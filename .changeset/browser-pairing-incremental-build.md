---
"@knpkv/browser-pairing": patch
---

The package build is now incremental (`tsc -b tsconfig.build.json`, without `--force`), and its buildinfo lives in `dist` and is excluded from the published files. codecommit, codecommit-web and control-center rebuild browser-pairing from their `prebuild`, `precheck` and `pretest` hooks. During a recursive workspace build those forced rebuilds rewrote `dist` while other packages compiled against it. A rebuild with nothing to do now writes nothing, and a deleted `dist` still rebuilds in full. The published files are unchanged.
