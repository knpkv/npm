---
"@knpkv/rly": minor
---

Add `Notice`, an inline one-sentence message with a state tone, optional action, and opt-in live-region announcement. Use it where packages hand-rolled tinted note paragraphs; `StatePanel` stays for titled, region-level states. `StatePanel` docs now explain that a polite status region must already be mounted to announce reliably, while an assertive alert may announce on insertion. Components that set their own `display` now still honour the native `hidden` attribute, through a new last `rly.state` layer that unlayered application CSS can still override. The open `RelayDock` trigger keeps its layout box and is `inert` instead of `hidden`. `StatePanel` no longer drops a caller-supplied `role` when it is not announcing.
