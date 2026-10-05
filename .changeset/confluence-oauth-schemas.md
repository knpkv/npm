---
"@knpkv/confluence-to-markdown": patch
---

`OAuthUserSchema`, `OAuthTokenSchema` and `OAuthConfigSchema` (and their types) in `@knpkv/confluence-to-markdown/Schemas` are now re-exported from `@knpkv/atlassian-common/config` instead of being a second copy. The types are unchanged: a type-equality check against the previous definitions passed before the switch.
