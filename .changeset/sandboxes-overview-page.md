---
"@knpkv/herdr-hub": minor
---

Add the Sandboxes overview page at `#sandboxes/overview`, between Host resources and Stacks. It shows the pool's cards in attention order with holder, time left and the 24-hour cap, cleanup steps, quarantine blockers, the last sweep, and lease, extend and release sheets. A failed read is one panel with Read again; a later failed read keeps the cards marked last known. The row appears only on the hub that serves the pool, read from the new `approvalApp.sandboxesEnabled` snapshot field. Until the hub can submit sandbox jobs, every viewer sees the pool read-only and the sheets point to the CLI.
