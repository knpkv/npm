---
"@knpkv/confluence-to-markdown": minor
---

Improve markdown rendering and round-trip fidelity for Confluence pages:

- Preserve nested lists across the round-trip — second-level bullets now become proper indented markdown lists instead of raw HTML with leftover `local-id` attributes.
- Unwrap table cells with a leading empty `<p>` placeholder so styled cells (e.g. `<td><p/><p><strong>Must</strong></p></td>`) collapse to their real content.
- Emit a synthetic markdown header divider (`| --- | --- |`) for tables that have no `<thead>`, so they render as tables in markdown viewers; the synthetic header is dropped on parse so the round-trip back to Confluence stays bit-exact.
- Render `expand` macros as GFM `<details><summary>` blocks; body content is now visible (and collapsible) in markdown viewers and round-trips back to a Confluence `expand` macro.
- Render inline `UserMention`, `StatusMacro`, and `TocMacro` as visible markdown links (`[@id](#cf-user:id)`, `[STATUS](#cf-status:Color)`, `[Table of Contents](#cf-toc:min:max)`) instead of opaque HTML comments; the parser recognises the `#cf-…` URL fragments and rebuilds the original AST nodes for round-trip.
- Add support for the `view-file` Confluence macro: attached files now render as `[filename](attachment:filename)` markdown links and round-trip back to `<ac:structured-macro ac:name="view-file">`.
- Fix an infinite loop in the structured-macro preprocessor: unsupported macros (e.g. `anchor`) were preserved verbatim inside a wrapping `<div>`, which caused `processStructuredMacros` to re-match the same `<ac:structured-macro>` tag forever and silently drop everything that came after it (including, for affected pages, the `view-file` macro).
