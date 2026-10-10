---
"@knpkv/herdr-connect": patch
"@knpkv/herdr-hub": patch
---

Connect in the hub uses a phone's full width. On screens up to 40rem the hub shell keeps one 16px gutter instead of 32px, and the embedded Connect panel adds none of its own, so an agent's row spans the screen less 32px. The Status options keep to one line whatever their counts, scrolling sideways rather than wrapping; host names still wrap so a long one stays readable.
