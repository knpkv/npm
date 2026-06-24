---
name: confluence
description: Use the @knpkv/confluence-to-markdown CLI to clone, fetch, sync, edit, commit, diff, and push Confluence Cloud pages as local GitHub Flavored Markdown. Trigger when the user asks an agent to manage Confluence documentation, inspect local Confluence sync status, create or delete pages, pull remote updates, export a page as markdown, or publish markdown changes back to Confluence.
---

# Confluence

Use the `confluence` binary to manage a local markdown mirror of Confluence Cloud pages.

## Preconditions

- Run commands from the workspace that contains, or should contain, the `.confluence/` sync directory.
- Authenticate before clone or sync with `confluence auth create`, `confluence auth configure`, and `confluence auth login`.
- Use OAuth for normal operation. API-token env vars may be available as `CONFLUENCE_API_KEY` and `CONFLUENCE_EMAIL`.
- Confirm before running `confluence push`, because it writes to Confluence.
- Confirm before running `confluence delete`, because it removes a local page that will be deleted remotely on the next push.
- Treat `confluence fetch --clean-markdown` output as read-only/export output. Do not push it back unless the user explicitly accepts metadata loss.

## Setup

```bash
confluence auth status
confluence auth create
confluence auth configure --client-id <id> --client-secret <secret>
confluence auth login
confluence auth login --site https://example.atlassian.net
```

Clone a page tree:

```bash
confluence clone --root-page-id <page-id> --base-url https://example.atlassian.net
confluence clone --url https://example.atlassian.net/wiki/spaces/SPACE/pages/<page-id>/Title
```

`clone` initializes `.confluence/`, creates local git history, and creates the `origin/confluence` tracking branch.

Fetch one latest page without creating a sync workspace:

```bash
confluence fetch --url https://example.atlassian.net/wiki/pages/<page-id>
confluence fetch --page-id <page-id> --base-url https://example.atlassian.net
confluence fetch --url https://example.atlassian.net/wiki/pages/<page-id> --clean-markdown
```

## Sync Workflow

Inspect before changing anything:

```bash
confluence status
confluence diff
confluence log --oneline
```

Pull remote changes:

```bash
confluence pull
confluence pull --force
confluence pull --replay-history
```

Commit local markdown edits:

```bash
confluence diff
confluence commit --message "Update release notes"
```

Preview and publish:

```bash
confluence push --dry-run
confluence push
```

## Page Operations

Create a page interactively:

```bash
confluence new
```

Delete a page locally, then commit and push the deletion:

```bash
confluence delete
confluence commit --message "Delete obsolete page"
confluence push
```

## Element Fidelity

Confluence pages are stored as Atlassian Document Format (ADF). The CLI emits readable Markdown where possible and exact `<!-- adf:... -->` placeholders/sidecars where Markdown cannot represent the element safely.

Use this quick reference before editing complex pages. It names every ADF element class agents are likely to see in Confluence Cloud, including elements that are only partially supported or currently preserved as placeholders.

| Confluence / ADF element                                                             | Markdown behavior                                                                        | Agent guidance                                                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Document root: `doc`                                                                 | Container only                                                                           | Do not create manually; it is rebuilt on push.                                                                                  |
| Text leaf: `text`                                                                    | Native Markdown text                                                                     | Safe to edit normally.                                                                                                          |
| Hard breaks: `hardBreak`                                                             | Markdown hard break; `<br>` inside tables                                                | Safe.                                                                                                                           |
| Paragraphs: `paragraph`                                                              | Native Markdown paragraph; paragraph marks use `adf:paragraph` wrappers                  | Keep wrappers when alignment or indentation is present.                                                                         |
| Headings: `heading`                                                                  | `#` through `######`                                                                     | Safe to edit normally.                                                                                                          |
| Rules: `rule`                                                                        | `---`                                                                                    | Safe.                                                                                                                           |
| Block quotes: `blockquote`                                                           | Native Markdown blockquotes                                                              | Safe unless nested placeholder markers are present.                                                                             |
| Code blocks: `codeBlock`                                                             | Fenced code blocks                                                                       | Preserve language fences and fence length.                                                                                      |
| Inline code mark: `code`                                                             | Backticks                                                                                | Safe.                                                                                                                           |
| Lists: `bulletList`, `orderedList`, `listItem`                                       | Native Markdown lists                                                                    | Safe unless list items contain tables, layouts, macros, or other placeholder-wrapped blocks.                                    |
| Tables: `table`, `tableRow`, `tableHeader`, `tableCell`                              | GFM tables wrapped with `adf:table` metadata at block level                              | Avoid restructuring complex tables; merged cells, widths, and some table attrs may not be visible in Markdown.                  |
| Links: `link` mark                                                                   | Native Markdown links                                                                    | Keep href intact; link titles are preserved when available but may be easy to lose during hand edits.                           |
| Mentions: `mention`                                                                  | `[@Name](confluence-mention://ACCOUNT_ID)` when account IDs are known                    | Keep the custom link target intact to preserve a real mention.                                                                  |
| Status lozenges: `status`                                                            | Inline HTML status span                                                                  | Edit label cautiously; keep status attributes intact.                                                                           |
| Dates: `date`                                                                        | Exact `adf:date` placeholder comments                                                    | Do not hand-edit unless intentionally replacing with plain text.                                                                |
| Emojis: `emoji`                                                                      | Exact `adf:emoji` placeholder comments                                                   | Do not hand-edit unless intentionally replacing with plain text.                                                                |
| Panels: `panel`                                                                      | Placeholder-wrapped content                                                              | Edit body text only; keep opening/closing `adf:panel` markers.                                                                  |
| Tasks: `taskList`, `taskItem`                                                        | Task-list Markdown wrapped with exact ADF metadata                                       | Keep markers/sidecars; state/localId metadata is not fully represented by Markdown.                                             |
| Decisions: `decisionList`, `decisionItem`                                            | Bullet-like visible text wrapped with exact ADF metadata                                 | Keep markers/sidecars; do not convert to a plain list unless accepting metadata loss.                                           |
| Expands: `expand`, `nestedExpand`                                                    | Visible title/body wrapped with exact ADF metadata                                       | Keep markers paired; avoid moving only one side of the wrapper.                                                                 |
| Layouts: `layoutSection`, `layoutColumn`                                             | Visible column content wrapped with exact ADF metadata                                   | Avoid manual reflow unless the user accepts layout loss.                                                                        |
| Cards: `inlineCard`, `blockCard`, `embedCard`                                        | URL cards when resolvable; otherwise unsupported/placeholder output                      | Do not delete `adf:*Card` refs unless replacing the card.                                                                       |
| Media blocks: `mediaSingle`, `mediaGroup`, `media`, `caption`                        | Image Markdown when a URL exists; otherwise `adf:media` placeholder; captions as text    | Warn that attachments and media metadata are not fully supported; captions may not round-trip structurally.                     |
| Inline media: `mediaInline`                                                          | `adf:media` placeholder                                                                  | Treat as unsupported media; preserve the placeholder.                                                                           |
| Macros/extensions: `extension`, `inlineExtension`, `bodiedExtension`                 | Native syntax for simple TOC; otherwise exact placeholder comments with sidecar metadata | Preserve macro markers. For TOC, `[[toc]]` and `[[toc:min=2,max=4]]` are supported; richer TOC attrs fall back to placeholders. |
| Text marks: `strong`, `em`, `strike`                                                 | Native Markdown                                                                          | Safe.                                                                                                                           |
| Text marks: `underline`, `textColor`, `backgroundColor`, `subsup`                    | Inline HTML and/or placeholder metadata                                                  | Keep HTML/attrs intact for round-trip fidelity.                                                                                 |
| Paragraph marks: `alignment`, `indentation`                                          | `adf:paragraph` wrapper metadata                                                         | Avoid removing wrapper markers.                                                                                                 |
| Placeholders and Confluence editor-only nodes such as `placeholder`                  | Unsupported placeholder output if encountered                                            | Stop and warn before editing; preserve any emitted marker/comment.                                                              |
| Unsupported wrappers: `unsupportedBlock`, `unsupportedInline`, `unsupportedFragment` | Unsupported placeholder output if encountered                                            | Stop and warn before editing; these indicate content the CLI cannot faithfully express yet.                                     |
| Unknown future ADF nodes or marks                                                    | `<!-- unsupported ADF ... -->` output or warning logs                                    | Stop and warn the user before editing; fetch/pull logs may contain details.                                                     |

Clean fetch mode removes `adf:` comments from stdout for readability. It is useful for summaries, exports, and copying text, but it discards data needed for exact push round-trips.

## Agent Workflow

1. Start with `confluence status` and `confluence diff`.
2. Read and edit markdown files under the configured docs path, usually `.confluence/docs`.
3. Preserve `<!-- adf:... -->` markers, `.adf.json` sidecars, front matter, and custom Confluence links unless the user explicitly asks for a lossy cleanup.
4. Use `confluence commit` instead of raw git for normal sync commits so external docs paths are copied into `.confluence/`.
5. Use `confluence push --dry-run` before `confluence push`.
6. Mention fidelity limits when editing complex Confluence content: media, cards, macros, panels, task lists, expand sections, layouts, dates, emojis, and some marks may not round-trip exactly.
