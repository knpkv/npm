---
"@knpkv/herdr-hub": minor
---

The Code page's "Open Code owner UI" link now works on the hub's tailnet URL, not only on loopback. The hub decides on the server: `/v1/modules/code/queue` returns `ownerUi` only when the request's WhoIs-authenticated tailnet node is the hub's own node (`approvalHub.nodeId`), never from `Host`, `X-Forwarded-*` or login headers. Module callers carry a server-computed `sameNode`, false unless an authorizer proves it.
