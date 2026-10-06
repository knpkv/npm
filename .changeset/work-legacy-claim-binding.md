---
"@knpkv/herdr-work": patch
---

Reopen Work stores migrated from the pre-session schema. In a legacy file whose lane claims predate goal and operation ids, a claim that a running agent binding recorded at the same revision now takes that binding's lane instead of the lane id; before, the first open migrated the file, and every later open rejected the binding. WorkStore also records each migrated claim's lane operation when the operation ledger already exists. A claim held by two bindings at one revision fails with `lane-binding-ambiguous`; a bound lane that disagrees with a field the claim recorded fails with `lane-binding-mismatch`. Both leave the file unchanged.
