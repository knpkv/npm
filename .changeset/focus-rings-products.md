---
"@knpkv/agent-usage": patch
"@knpkv/codecommit-web": patch
"@knpkv/control-center": patch
"@knpkv/herdr-approvals": patch
"@knpkv/herdr-connect": patch
"@knpkv/herdr-monitor": patch
"@knpkv/herdr-work": patch
"@knpkv/jcf-web": patch
"@knpkv/review": patch
---

Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
