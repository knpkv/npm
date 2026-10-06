---
"@knpkv/herdr-approvals": minor
---

The Approvals tab is a countdown:

- It leads with the request that expires first ("4m 12s until Apply Nix configuration expires").
- Every pending request, from this host and others, is listed soonest first, with its time left.
- One decision bar sits on the selected request and names what it decides.

Decisions show the hub's answer, including a refusal, never an assumed success. A request becomes expired only when the hub says so; at zero its clock reads "expiring". Screen readers hear a request once as it enters its last minute and when it expires, not every tick. Keyboard shortcuts follow the same rules as the buttons, so a request decided on another host, or one already being sent, can't be decided by keyboard either.
