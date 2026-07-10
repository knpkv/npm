---
"@knpkv/confluence-to-markdown": patch
---

Honor Markdown table cell edits on push by merging GFM content over sidecar attrs. Headerless tables keep their synthetic empty GFM header row out of the row alignment, and cells with multi-block bodies (multiple paragraphs, lists, code blocks) keep the authoritative sidecar body instead of adopting the flattened GFM copy.
