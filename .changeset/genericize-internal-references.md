---
"@knpkv/clockify-api-client": patch
"@knpkv/codecommit-web": patch
"@knpkv/codecommit": patch
"@knpkv/jira-clockify": patch
"@knpkv/rly": patch
---

Replace internal project names, keys and work descriptions in fixtures, examples and documentation
with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
public package would otherwise see.

`ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
declaring the response it wants, instead of providing a layer inside every test body.
