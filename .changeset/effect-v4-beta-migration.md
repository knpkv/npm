---
"@knpkv/atlassian-common": minor
"@knpkv/clockify-api-client": minor
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
"@knpkv/confluence-api-client": minor
"@knpkv/confluence-to-markdown": minor
"@knpkv/jira-api-client": minor
"@knpkv/jira-cli": minor
"@knpkv/jira-clockify": minor
---

Migrate the package workspace to Effect v4 beta.

This updates runtime and peer dependencies to the Effect v4 beta module layout,
adopts Effect platform/runtime services for Node process, HTTP, filesystem, and
clock access, and refreshes package export metadata to point published type
entries at emitted `dist/*.d.ts` declarations.

CodeCommit packages now use Effect v4-compatible AWS and cache layers, including
typed `distilled-aws` context services, shared cached-comment decoding, and
schema-derived config defaults. Jira and Confluence OAuth callback servers bind
the expected local callback port range again under the Effect v4 Node HTTP
server layer.

The retired Claude AI packages have been removed from the workspace.
