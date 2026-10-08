---
"@knpkv/jcf-web": minor
---

The agent conversation no longer moves while the agent works. Below 1100px the sheet has a fixed height, and new output scrolls inside it. A read's progress sits below the conversation, so the conversation stays put when the progress goes. On a short window, such as a laptop at 200% zoom, the sheet uses the full height. The masthead status keeps room for its longest wording, so the page no longer re-wraps as the status changes. The editor picks layers with the same buttons as the calendar, instead of browser checkboxes, and its note grows with what you type, with no resize grip. A failed read is stated once, in the alert; the totals line just says how old the totals are. After a failed or cancelled read, the agent conversation stops saying it is waiting.
