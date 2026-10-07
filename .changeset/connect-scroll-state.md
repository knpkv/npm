---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-approvals": minor
---

Connect knows where a terminal is really scrolled to. The hub reads herdr's scroll position for the open pane (at most twice a second per session and ten times a second across the host) and sends it to the browser, so a pane someone left scrolled back opens with "Older output, N lines back", and Latest returns in exactly that many lines, one command per frame, until a fresh reading says the pane is at the bottom. When the position can't be read it is shown as unknown, never as the bottom, and Connect falls back to its previous behaviour.
