---
"@knpkv/control-center-sql": minor
---

Ship a patched copy of `effect-qb` 0.22.0 in `dist/vendor/effect-qb` so the package runs on Effect 4.0.0. No `effect-qb` release supports Effect 4.0.0 yet, and the workspace patch does not travel with a published dependency. `effect-qb` is no longer a runtime dependency; `pgsql-ast-parser` is. The copy is temporary and goes away once upstream supports Effect 4.0.0.
