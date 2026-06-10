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

Confluence macros now survive a pull → edit → push round-trip: extension
placeholders carry the macro's full attrs (parameters, layout, localId) as a
base64 blob, and a bodied macro's body is re-attached from the blocks between
its `<!-- adf:bodiedExtension … -->` / `<!-- adf:/bodiedExtension -->`
markers. Constructs that still degrade on push (panels, task lists, dates,
emojis, expand sections, inline cards, media captions) are documented under
"Known fidelity limitations" in the README.
