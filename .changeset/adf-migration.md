---
"@knpkv/confluence-to-markdown": minor
---

Switch wire format from Confluence storage format to Atlassian Document
Format (ADF). Push (markdown → ADF) is now handled by the official
`@atlaskit/editor-markdown-transformer` + `@atlaskit/editor-json-transformer`;
pull (ADF → markdown) by an in-package tree walker typed against
`@atlaskit/adf-schema`. The bespoke storage-format parsers and serializers
(~140 KB) are removed. CLI behavior is unchanged. When `saveSource` is
enabled, the `.source` companion file is now `<page>.source.json` instead of
`<page>.html`; existing companion `.html` files are harmless and can be
deleted.
