# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root for the project glossary.
- `docs/adr/` for architectural decisions that touch the area being changed.

If a file does not exist, proceed silently. Producer skills create domain docs lazily when terms or decisions are resolved.

## Layout

This is a single-context repo:

```text
/
├── CONTEXT.md
└── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly instead of silently overriding it.
