---
"@knpkv/herdr-connect": patch
"@knpkv/herdr-approvals": patch
---

The hub no longer jumps while its first content loads. Connect's agent directory and the Work board each hold a screen of space while loading, so the coordinator chat (Connect) and the agents and history panels (Work) stay out of view instead of being pushed down when the list or board arrives. CLS on a cold load was 0.60 (Connect, 768) and 0.48 (Work, 1440).
