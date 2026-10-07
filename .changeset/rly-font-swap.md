---
"@knpkv/rly": patch
"@knpkv/agent-usage": patch
"@knpkv/codecommit-web": patch
"@knpkv/control-center": patch
"@knpkv/herdr-approvals": patch
"@knpkv/jcf-web": patch
"@knpkv/review": patch
---

Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.
