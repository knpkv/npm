---
"@knpkv/control-center": minor
"@knpkv/control-center-sql": minor
---

Replace portfolio readiness N+1 reads with one bounded, parameterized
`effect-qb` query plan while retaining Schema decoding, materialization
verification, and malformed-row quarantine.

Reset prototype persistence to one exact unstable schema snapshot. Historical
migrations and the migration ledger are intentionally removed until the data
model is stable and released databases require forward upgrades.
