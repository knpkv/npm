---
"@knpkv/sandbox-pool": minor
"@knpkv/herdr-hub": minor
---

Sandboxes cards show this month's spend against the pool budget's alarm and hard stop. The sweep reads it through a new host-supplied `SpendReader` and keeps each account's latest reading. There is no bar without a reader or without `spend` limits in the pool contract.
