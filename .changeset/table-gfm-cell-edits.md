---
"@knpkv/confluence-to-markdown": patch
---

Honor Markdown table cell edits on push by merging GFM content over sidecar attrs. Rows and columns are aligned by plain-text fingerprint: cell edits merge freely when the shape is unchanged, a single row/column insert or delete merges anywhere in the table, pure reorders keep attrs travelling with the moved content, and edits combined with a tail append are both honored. Header-column identity is restored on rows inserted via GFM, headerless tables keep their synthetic empty GFM header row out of the alignment, and cells with multi-block bodies keep the authoritative sidecar body instead of adopting the flattened GFM copy. Ambiguous shapes fall back to the sidecar node instead of guessing: duplicate-text rows/columns around a structural change, reorders mixed with edits, rows and columns changed in the same push, ragged (non-rectangular) tables, and merged-cell tables.
