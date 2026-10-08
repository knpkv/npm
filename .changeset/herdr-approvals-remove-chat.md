---
"@knpkv/herdr-approvals": minor
---

The hub no longer has a coordinator chat. The chat panel is gone from the Approvals dashboard and from below Connect's terminal, the page stops polling for chat, and the `GET`/`POST /v1/chat` routes are removed. The dashboard snapshot drops `chat` and `approvalApp.chatEnabled`, and `dashboardPolls` no longer reports `chat`. Notifications now show on the canonical hub whether or not chat history exists. A coordinator chat job queued before the upgrade still runs through Fleet's `runCoordinatorChat`. `@knpkv/herdr-coordinator`'s chat model and Fleet's chat operations are unchanged.
