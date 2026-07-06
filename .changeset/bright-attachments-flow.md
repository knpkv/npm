---
"@knpkv/atlassian-common": minor
"@knpkv/confluence-api-client": minor
"@knpkv/confluence-to-markdown": minor
"@knpkv/jira-api-client": minor
"@knpkv/jira-cli": minor
---

Add Jira and Confluence attachment support.

- Add shared attachment rendering and placeholder replacement helpers.
- Support multipart attachment upload calls in Jira and Confluence API clients.
- Render Jira attachments as inline image previews or links with hidden attachment metadata.
- Resolve Confluence media attachments to visible Markdown previews while preserving native media ADF identity.
- Add explicit Jira and Confluence attachment upload commands with optional Markdown placeholder insertion.
