---
"@knpkv/bounded-io": minor
"@knpkv/ai-claude": patch
"@knpkv/ai-codex": patch
"@knpkv/ai-runtime": patch
"@knpkv/herdr-approvals": patch
"@knpkv/herdr-connect": patch
"@knpkv/herdr-fleet": patch
"@knpkv/herdr-tailscale": patch
---

New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
