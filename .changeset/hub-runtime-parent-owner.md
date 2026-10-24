---
"@knpkv/herdr-hub": patch
---

The hub keeps its apps down when the parent of its runtime directory belongs to another user (not this user, not root): that user could rename the directory away whatever its mode bits say.
