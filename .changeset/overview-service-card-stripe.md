---
"@knpkv/control-center": patch
"@knpkv/rly": patch
---

The Overview's first-service cards lose their 3px service-coloured top bar and keep an even 1px border, as the design draws them. rly's stripe lint now treats a card's block-start (top) edge like an inline side: a coloured or thick top bar, as a border or as an inset shadow, is a stripe; block-end underlines (tabs) stay allowed. Existing top bars elsewhere are baselined with their reason.
