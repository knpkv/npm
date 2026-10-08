---
"@knpkv/herdr-approvals": minor
---

A host's own dashboard page now hydrates cleanly. It was server-rendered as static markup, which merges adjacent text, and the browser then failed with React error #418 and re-rendered the page. It also stops polling `/v1/chat`, `/v1/push/config` and (when the fleet is cross-host) `/v1/work`, which that listener doesn't serve and which only answered 404. The dashboard snapshot's `approvalApp` gains `workEnabled`, set by the same rule the server uses to route `/v1/work`.
